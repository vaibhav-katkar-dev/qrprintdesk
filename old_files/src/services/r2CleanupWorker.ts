import { Db } from 'mongodb';
import { deleteR2Object } from './r2.js';
import { OrderDocument, JobState } from '../types.js';

export class R2CleanupWorker {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(private db: Db) {}

  public start(intervalMs: number = 60 * 60 * 1000): void { // Runs hourly by default
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => this.runCleanupSweep(), intervalMs);
    // Initial run on boot after 10 seconds
    setTimeout(() => this.runCleanupSweep(), 10000);
  }

  public async runCleanupSweep(): Promise<{ scanned: number; cleaned: number }> {
    const now = new Date();
    let cleanedCount = 0;

    try {
      // 1. Find orders whose retention period has expired and files have not been cleaned up yet
      // Active states ('QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'MANUAL_REVIEW') are excluded
      // Rule: Never delete a paid order's file before retention ends.
      const excludedStates: JobState[] = ['QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'MANUAL_REVIEW'];
      const query: any = {
        retentionUntil: { $lte: now },
        status: { $nin: excludedStates },
        'files.0': { $exists: true },
        filesCleanedUp: { $ne: true }
      };

      const expiredOrders = await this.db.collection<OrderDocument & { filesCleanedUp?: boolean }>('orders')
        .find(query)
        .limit(100)
        .toArray();

      for (const order of expiredOrders) {
        // Double check retention protection
        if (order.retentionUntil > now) {
          continue;
        }

        let allFilesDeleted = true;
        for (const file of order.files) {
          if (file.fileKey) {
            const ok = await deleteR2Object(file.fileKey);
            if (!ok) {
              allFilesDeleted = false;
            }
          }
        }

        if (allFilesDeleted) {
          await this.db.collection('orders').updateOne(
            { _id: order._id },
            {
              $set: {
                filesCleanedUp: true,
                updatedAt: new Date()
              },
              $push: {
                auditTrail: {
                  $each: [
                    {
                      actor: 'system',
                      from: order.status,
                      to: order.status,
                      reason: `Retention expired at ${order.retentionUntil.toISOString()}; files deleted from storage`,
                      time: new Date()
                    }
                  ],
                  $slice: -20
                }
              } as any
            }
          );
          cleanedCount++;
        }
      }

      return { scanned: expiredOrders.length, cleaned: cleanedCount };
    } catch (err) {
      return { scanned: 0, cleaned: 0 };
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
