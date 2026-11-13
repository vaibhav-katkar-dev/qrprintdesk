import { Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { OutboxDocument, JobDocument } from '../types.js';
import { WebSocketHub } from './wsHub.js';
import { transitionJobState } from './stateMachine.js';

export class OutboxWorker {
  private workerId = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  private isRunning = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(private db: Db, private wsHub: WebSocketHub) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
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
      } catch (err) {
        // Non-fatal sweep error
      }
    }, 5 * 60 * 1000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    if (this.sweepInterval) clearInterval(this.sweepInterval);
  }
}
