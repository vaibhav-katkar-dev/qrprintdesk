import { Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { OutboxDocument, JobDocument, OrderDocument } from '../types.js';
import { WebSocketHub } from './wsHub.js';
import { transitionJobState } from './stateMachine.js';
import { fulfillPaidOrder } from './paymentFulfillment.js';

// ── Global instant-dispatch event bus ────────────────────────────────────────
// When fulfillPaidOrder() inserts a new outbox entry it emits 'outbox:new'.
// The worker wakes immediately (< 1ms) instead of waiting up to 1 second.
export const outboxBus = new EventEmitter();
outboxBus.setMaxListeners(50);

export class OutboxWorker {
  private workerId = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  private isRunning = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private sweepInterval: NodeJS.Timeout | null = null;
  private wakeupListener: (() => void) | null = null;

  constructor(private db: Db, private wsHub: WebSocketHub) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // ── Instant wake-up: listen for new outbox entries ────────────────────
    // When fulfillPaidOrder emits 'outbox:new', cancel the pending 1-second
    // sleep and process immediately. Latency: payment → WS push drops from
    // ~1,000 ms (poll) to ~10–25 ms (event-driven).
    this.wakeupListener = () => {
      if (this.pollTimeout) {
        clearTimeout(this.pollTimeout);
        this.pollTimeout = null;
      }
      this.processOutboxBatch();
    };
    outboxBus.on('outbox:new', this.wakeupListener);

    this.scheduleNextPoll(100);
    this.startStuckJobSweep();
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    this.pollTimeout = setTimeout(() => this.processOutboxBatch(), delayMs);
  }

  public async processOutboxBatch(): Promise<void> {
    try {
      const now = new Date();
      // Atomic claim of pending outbox entries ready for dispatch
      const claimed = await this.db.collection<OutboxDocument>('outbox').findOneAndUpdate(
        {
          status: 'PENDING',
          nextAttemptAt: { $lte: now }
        },
        {
          $set: {
            status: 'PROCESSING',
            claimedBy: this.workerId,
            updatedAt: now
          }
        },
        { returnDocument: 'after' }
      );

      if (!claimed) {
        // Nothing pending; poll again in 1 second
        this.scheduleNextPoll(1000);
        return;
      }

      const shopId = claimed.shopId.toString();
      const jobId = claimed.payload.id || claimed.jobId;

      // Check if agent is currently connected and deliver compact hint
      const delivered = this.wsHub.sendJobHint(shopId, jobId);

      if (delivered) {
        await this.db.collection<OutboxDocument>('outbox').updateOne(
          { _id: claimed._id },
          {
            $set: {
              status: 'DELIVERED',
              updatedAt: new Date()
            }
          }
        );
      } else {
        // Agent not connected or send failed: backoff retry
        const attempts = claimed.attempts + 1;
        const maxAttempts = 10;
        const backoffSeconds = Math.min(300, Math.pow(2, attempts)); // Exponential backoff up to 5 min
        const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);

        await this.db.collection<OutboxDocument>('outbox').updateOne(
          { _id: claimed._id },
          {
            $set: {
              status: attempts >= maxAttempts ? 'FAILED' : 'PENDING',
              attempts,
              nextAttemptAt,
              updatedAt: new Date()
            }
          }
        );
      }

      // Check immediately for another item
      this.scheduleNextPoll(50);
    } catch (err) {
      this.scheduleNextPoll(2000);
    }
  }

  // Low-frequency sweep for stuck jobs (every 5 minutes)
  private startStuckJobSweep(): void {
    this.sweepInterval = setInterval(async () => {
      try {
        const threshold = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes stuck

        // ── Sweep 1: Stuck DOWNLOADING / PRINT_SUBMITTED jobs ─────────────────
        const stuckJobs = await this.db.collection<JobDocument>('jobs')
          .find({
            status: { $in: ['DOWNLOADING', 'PRINT_SUBMITTED'] },
            updatedAt: { $lte: threshold }
          })
          .toArray();

        for (const job of stuckJobs) {
          // Route stuck print outcomes to MANUAL_REVIEW, never auto-resubmit
          await transitionJobState({
            db: this.db,
            jobId: job.jobId,
            expectedState: job.status,
            targetState: 'MANUAL_REVIEW',
            actor: 'system',
            reason: `Stuck in ${job.status} for >20 mins; automatically flagged for manual review`
          });
        }

        // ── Sweep 2: PAID orders with no corresponding job (crash-recovery) ───
        // Guard: only look at orders older than 5 mins to avoid race with fresh orders
        const orphanThreshold = new Date(Date.now() - 5 * 60 * 1000);
        const orphanedPaidOrders = await this.db.collection<OrderDocument>('orders')
          .find({ status: 'PAID', createdAt: { $lte: orphanThreshold } })
          .toArray();

        for (const order of orphanedPaidOrders) {
          const job = await this.db.collection<JobDocument>('jobs').findOne({ orderId: order.orderId });
          if (!job) {
            // Job was never created (server crashed between PAID update and job insert)
            await fulfillPaidOrder({
              db: this.db,
              orderId: order.orderId,
              wsHub: this.wsHub,
              reason: 'Recovery sweep — job missing for PAID order'
            });
          }
        }

        // ── Sweep 3: QUEUED jobs whose outbox has exhausted all retries ───────
        const queuedJobs = await this.db.collection<JobDocument>('jobs')
          .find({ status: 'QUEUED', updatedAt: { $lte: threshold } })
          .toArray();

        for (const job of queuedJobs) {
          const exhaustedOutbox = await this.db.collection<OutboxDocument>('outbox').findOne({
            jobId: job.jobId,
            status: 'FAILED'
          });
          if (exhaustedOutbox) {
            await transitionJobState({
              db: this.db,
              jobId: job.jobId,
              expectedState: 'QUEUED',
              targetState: 'MANUAL_REVIEW',
              actor: 'system',
              reason: 'Outbox exhausted all 10 delivery attempts — flagged for manual review'
            });
          }
        }
      } catch (err) {
        // Non-fatal sweep error
      }
    }, 5 * 60 * 1000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    if (this.sweepInterval) clearInterval(this.sweepInterval);
    if (this.wakeupListener) outboxBus.off('outbox:new', this.wakeupListener);
  }
}
