import { Db, ClientSession } from 'mongodb';
import { JobDocument, JobState, AuditEntry, OrderDocument } from '../types.js';

export const ALLOWED_TRANSITIONS: Record<JobState, JobState[]> = {
  UPLOADED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'FAILED', 'CANCELLED'],
  PAID: ['QUEUED', 'REFUND_PENDING', 'CANCELLED'],
  QUEUED: ['DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED', 'CANCELLED', 'FAILED', 'MANUAL_REVIEW', 'REJECTED'],
  DOWNLOADING: ['PRINT_SUBMITTED', 'COMPLETED', 'QUEUED', 'FAILED', 'MANUAL_REVIEW', 'REJECTED'],
  PRINT_SUBMITTED: ['COMPLETED', 'MANUAL_REVIEW', 'FAILED', 'REJECTED'],
  MANUAL_REVIEW: ['COMPLETED', 'REFUND_PENDING', 'QUEUED', 'CANCELLED', 'FAILED'],
  REFUND_PENDING: ['CANCELLED', 'FAILED'],
  REJECTED: ['MANUAL_REVIEW', 'REFUND_PENDING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
};

export interface TransitionParams {
  db: Db;
  jobId: string;
  expectedState: JobState | JobState[];
  targetState: JobState;
  actor: AuditEntry['actor'];
  actorId?: string;
  opId?: string;
  reason?: string;
  session?: ClientSession;
}

export interface TransitionResult {
  success: boolean;
  job?: JobDocument;
  error?: string;
  idempotentHit?: boolean;
}

export async function transitionJobState(params: TransitionParams): Promise<TransitionResult> {
  const { db, jobId, expectedState, targetState, actor, actorId, opId, reason, session } = params;

  // 1. Check if this is an idempotent retry by opId
  const jobsCol = db.collection<JobDocument>('jobs');
  const currentJob = await jobsCol.findOne({ jobId }, { session });

  if (!currentJob) {
    return { success: false, error: `Job ${jobId} not found` };
  }

  if (opId && currentJob.lastOpId === opId) {
    // Same opId already processed
    return { success: true, job: currentJob, idempotentHit: true };
  }

  // 2. Verify expected state matches current state
  const allowedFrom = Array.isArray(expectedState) ? expectedState : [expectedState];
  if (!allowedFrom.includes(currentJob.status)) {
    return {
      success: false,
      error: `Stale transition: expected ${allowedFrom.join('|')}, found ${currentJob.status}`
    };
  }

  // 3. Validate allowed transition matrix
  const allowedNext = ALLOWED_TRANSITIONS[currentJob.status] || [];
  if (!allowedNext.includes(targetState)) {
    return {
      success: false,
      error: `Illegal transition from ${currentJob.status} to ${targetState}`
    };
  }

  // 4. Construct audit entry
  const now = new Date();
  const audit: AuditEntry = {
    actor,
    actorId,
    from: currentJob.status,
    to: targetState,
    opId,
    reason,
    time: now
  };

  // 5. Atomic findOneAndUpdate
  const updateDoc: any = {
    $set: {
      status: targetState,
      updatedAt: now,
      ...(opId ? { lastOpId: opId } : {}),
      ...(reason ? { failureReason: reason } : {})
    },
    $push: {
      auditTrail: {
        $each: [audit],
        $slice: -20 // Keep short audit trail (last 20 entries)
      }
    }
  };

  const query: any = {
    jobId,
    status: { $in: allowedFrom }
  };

  const result = await jobsCol.findOneAndUpdate(query, updateDoc, {
    returnDocument: 'after',
    session
  });

  if (!result) {
    return {
      success: false,
      error: `Atomic transition failed for job ${jobId}: state changed concurrently`
    };
  }

  // Also sync order status if linked
  if (result.orderId) {
    await db.collection<OrderDocument>('orders').updateOne(
      { orderId: result.orderId },
      {
        $set: { status: targetState, updatedAt: now },
        $push: {
          auditTrail: {
            $each: [audit],
            $slice: -20
          }
        }
      },
      { session }
    );
  }

  return { success: true, job: result };
}

export async function reportPrintOutcome(params: {
  db: Db;
  jobId: string;
  outcome: 'SUCCESS' | 'UNCERTAIN' | 'DEFINITIVE_FAILURE';
  actorId?: string;
  opId?: string;
  reason?: string;
  session?: ClientSession;
}): Promise<TransitionResult> {
  const { db, jobId, outcome, actorId, opId, reason, session } = params;

  if (outcome === 'SUCCESS') {
    return transitionJobState({
      db,
      jobId,
      expectedState: ['PRINT_SUBMITTED', 'DOWNLOADING', 'QUEUED', 'MANUAL_REVIEW'],
      targetState: 'COMPLETED',
      actor: 'agent',
      actorId,
      opId,
      reason: reason || 'Print completed successfully',
      session
    });
  }

  if (outcome === 'UNCERTAIN') {
    // UNCERTAIN -> MANUAL_REVIEW, NEVER auto-resubmit!
    return transitionJobState({
      db,
      jobId,
      expectedState: ['PRINT_SUBMITTED', 'DOWNLOADING', 'QUEUED', 'MANUAL_REVIEW'],
      targetState: 'MANUAL_REVIEW',
      actor: 'agent',
      actorId,
      opId,
      reason: reason || 'Uncertain print outcome, routed to MANUAL_REVIEW',
      session
    });
  }

  // DEFINITIVE_FAILURE
  return transitionJobState({
    db,
    jobId,
    expectedState: ['PRINT_SUBMITTED', 'DOWNLOADING', 'QUEUED', 'MANUAL_REVIEW'],
    targetState: 'FAILED',
    actor: 'agent',
    actorId,
    opId,
    reason: reason || 'Definitive print failure',
    session
  });
}
