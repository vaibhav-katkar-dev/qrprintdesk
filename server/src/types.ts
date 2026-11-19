import { ObjectId } from 'mongodb';

export type JobState =
  | 'UPLOADED'
  | 'PAYMENT_PENDING'
  | 'PAY_AT_COUNTER_PENDING'
  | 'PAID'
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'PRINT_SUBMITTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'REFUND_PENDING'
  | 'MANUAL_REVIEW';

export interface AuditEntry {
  actor: 'customer' | 'agent' | 'admin' | 'system' | 'cashfree' | 'payu';
  actorId?: string;
  from: JobState;
  to: JobState;
  opId?: string;
  reason?: string;
  time: Date;
}

export interface EasySplitConfig {
  vendorId: string; // Cashfree Easy Split vendor_id
  status: 'NOT_REGISTERED' | 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'FAILED';
  bankDetails?: {
    accountNumber?: string;
    ifsc?: string;
    upiId?: string;
    accountHolder?: string;
  };
  kycDetails?: {
    pan?: string;
    businessName?: string;
    businessType?: string;
    accountType?: 'INDIVIDUAL' | 'BUSINESS';
    gst?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      postalCode?: string;
    };
  };
  kycDocuments?: Record<string, {
    filename: string;
    uploadedAt: Date;
    size: number;
    path: string;
  }>;
  scheduleOption?: string; // e.g. 'T_PLUS_1', 'DAILY', 'INSTANT'
  commissionPercent?: number; // Platform fee percentage, e.g. 5%
  fixedCutPaise?: number;
  cfResponse?: any;
  updatedAt?: Date;
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
  easySplit?: EasySplitConfig;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  printOptions?: {
    allowColor: boolean;
    allowBW: boolean;
    allowSimplex: boolean;
    allowDuplexLong: boolean;
    allowDuplexShort: boolean;
    allow2on1: boolean;
    allowPortrait: boolean;
    allowLandscape: boolean;
    defaultColorMode: 'monochrome' | 'color';
    defaultOrientation: 'portrait' | 'landscape';
    defaultDuplex: 'simplex' | 'duplexlong' | 'duplexshort';
    defaultPagesPerSheet: 1 | 2;
    maxCopies: number;
    allowStampPaper?: boolean;
    allowIDCardMerge?: boolean;
  };
  requireCustomerName?: boolean;
  payAtCounter?: boolean;
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
    pageRange?: string; // Optional custom pages e.g. "1-3, 5"
  }>;
  printOptions: {
    copies: number;
    colorMode: 'monochrome' | 'color';
    duplexMode: 'simplex' | 'duplexlong';
    paperSize: string;
    fitMode: string;
    orientation: string;
    pagesPerSheet: number;
    pageRange?: string; // Global or per-order page range
    stampPaperMode?: boolean;
  };
  pricing: {
    amountPaise: number; // integer paise
    currency: 'INR';
    platformFeePaise: number;
    vendorSharePaise: number;
  };
  orderSplits?: Array<{
    vendorId: string;
    amount?: number;
    percentage?: number;
    status?: 'CREATED' | 'SETTLED' | 'FAILED' | 'REVERSED';
    settlementTxnId?: string;
  }>;
  status: JobState;
  paymentSessionId?: string;
  providerOrderId?: string; // Cashfree order ID
  payAtCounter?: boolean;
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
  provider: 'cashfree' | 'payu';
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
  settlementTxnId?: string;
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
    payAtCounter?: boolean;
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

export interface SettlementDocument {
  _id: ObjectId;
  settlementId: string;
  shopId?: ObjectId;
  vendorId: string;
  orderId?: string;
  eventType:
    | 'VENDOR_SETTLEMENT_INITIATED'
    | 'VENDOR_SETTLEMENT_SUCCESS'
    | 'VENDOR_SETTLEMENT_FAILED'
    | 'VENDOR_SETTLEMENT_REVERSED'
    | 'ON_DEMAND_TRANSFER'
    | 'REFUND_ADJUSTMENT'
    | 'MANUAL_ADJUSTMENT';
  amountRupees: number;
  status: 'INITIATED' | 'SUCCESS' | 'FAILED' | 'REVERSED';
  rawWebhookData?: any;
  failureReason?: string;
  transferRemark?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserDocument {
  _id: ObjectId;
  username: string;
  email: string;
  passwordHash: string;
  role: 'SUPER_ADMIN' | 'FINANCE_ADMIN';
  token?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

