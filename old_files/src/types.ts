import { ObjectId } from 'mongodb';

export type JobState =
  | 'UPLOADED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'PRINT_SUBMITTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'MANUAL_REVIEW';

export interface AuditEntry {
  actor: 'customer' | 'agent' | 'admin' | 'system' | 'cashfree';
  actorId?: string;
  from: JobState;
  to: JobState;
  opId?: string;
  reason?: string;
  time: Date;
}

export interface ShopDocument {
  _id: ObjectId;
  name: string;
  slug: string;
  ownerEmail: string;
  pinHash: string;
  pricing: {
    bwPerPagePaise: number;
    colorPerPagePaise: number;
    duplexDiscountPaise: number;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDocument {
  _id: ObjectId;
  shopId: ObjectId;
  name: string;
  tokenHash: string; // SHA-256 of agent API secret
  isRevoked: boolean;
  lastHeartbeat?: Date;
  ipAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderDocument {
  _id: ObjectId;
  orderId: string; // UUID / human code
  shopId: ObjectId;
  customerName?: string;
  customerPhone?: string;
  files: Array<{
    fileKey: string;
    originalFilename: string;
    fileSize: number;
    mimeType: string;
    checksum?: string;
    pageCount: number;
  }>;
  printOptions: {
    copies: number;
    colorMode: 'monochrome' | 'color';
    duplexMode: 'simplex' | 'duplexlong';
    paperSize: string;
    fitMode: string;
    orientation: string;
    pagesPerSheet: number;
  };
  pricing: {
    amountPaise: number; // integer paise
    currency: 'INR';
    platformFeePaise: number;
    vendorSharePaise: number;
  };
  status: JobState;
  paymentSessionId?: string;
  providerOrderId?: string; // Cashfree order ID
  retentionUntil: Date;
  auditTrail: AuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface JobDocument {
  _id: ObjectId;
  jobId: string; // unique job identifier
  orderId: string;
  shopId: ObjectId;
  status: JobState;
  retryCount: number;
  lastOpId?: string;
  failureReason?: string;
  auditTrail: AuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentDocument {
  _id: ObjectId;
  orderId: string;
  shopId: ObjectId;
  provider: 'cashfree';
  providerOrderId: string;
  providerPaymentId?: string;
  providerEventId?: string; // unique for webhooks
  amountPaise: number;
  currency: 'INR';
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED';
  rawPayload?: any;
  createdAt: Date;
}

export interface LedgerDocument {
  _id: ObjectId;
  shopId: ObjectId;
  orderId: string;
  grossPaise: number;
  platformFeePaise: number;
  vendorSharePaise: number;
  currency: 'INR';
  settled: boolean;
  createdAt: Date;
}

export interface OutboxDocument {
  _id: ObjectId;
  shopId: ObjectId;
  jobId: string;
  payload: {
    type: 'job';
    id: string;
    op: string;
  };
  status: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  nextAttemptAt: Date;
  claimedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdempotencyKeyDocument {
  _id: ObjectId;
  key: string;
  scope: string;
  responsePayload: any;
  createdAt: Date;
}
