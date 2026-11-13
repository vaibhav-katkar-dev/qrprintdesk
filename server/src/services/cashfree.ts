import { Cashfree, CFEnvironment } from 'cashfree-pg';

function getCredentials() {
  const isProduction = process.env.CASHFREE_ENV === 'PRODUCTION';
  const environment = isProduction ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
  const appId = (process.env.CASHFREE_APP_ID || 'TEST_APP_ID').trim();
  const secretKey = (process.env.CASHFREE_SECRET_KEY || 'TEST_SECRET_KEY').trim();
  const baseUrl = isProduction ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  return { isProduction, environment, appId, secretKey, baseUrl };
}

function getHeaders() {
  const { appId, secretKey } = getCredentials();
  return {
    'x-client-id': appId,
    'x-client-secret': secretKey,
    'x-api-version': '2023-08-01',
    'Content-Type': 'application/json'
  };
}

export interface OrderSplitInput {
  vendor_id: string;
  percentage?: number;
  amount?: number;
  tags?: Record<string, string>;
}

export interface CreatePaymentSessionParams {
  orderId: string;
  amountPaise: number;
  customerPhone?: string;
  customerName?: string;
  returnUrl?: string;
  orderSplits?: OrderSplitInput[];
}

export interface EasySplitVendorParams {
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  verifyAccount?: boolean;
  scheduleOption?: number; // 1 = T+1, etc.
  bankDetails?: {
    accountNumber: string;
    accountHolder: string;
    ifsc: string;
  };
  upi?: {
    vpa: string;
  };
  kycDetails?: {
    accountType?: 'INDIVIDUAL' | 'BUSINESS';
    businessType?: string;
    pan?: string;
    gst?: string;
  };
}

/**
 * 1. Register vendor with Easy Split (POST /easy-split/vendors)
 */
export async function createEasySplitVendor(params: EasySplitVendorParams): Promise<any> {
  const { baseUrl } = getCredentials();

  const payload: any = {
    vendor_id: params.vendorId,
    status: 'ACTIVE',
    name: params.name,
    email: params.email,
    phone: params.phone,
    verify_account: params.verifyAccount === true,
    dashboard_access: false,
    schedule_option: params.scheduleOption || 1
  };

  if (params.bankDetails && params.bankDetails.accountNumber && params.bankDetails.ifsc) {
    payload.bank = {
      account_number: params.bankDetails.accountNumber.trim(),
      account_holder: (params.bankDetails.accountHolder || params.name).trim(),
      ifsc: params.bankDetails.ifsc.trim().toUpperCase()
    };
  } else if (params.upi && params.upi.vpa) {
    payload.upi = {
      vpa: params.upi.vpa.trim()
    };
  }

  payload.kyc_details = {
    account_type: params.kycDetails?.accountType || 'INDIVIDUAL',
    business_type: params.kycDetails?.businessType || 'Retail and Shopping',
    pan: (params.kycDetails?.pan || 'AAAPA1234A').trim().toUpperCase(),
    ...(params.kycDetails?.gst ? { gst: params.kycDetails.gst.trim().toUpperCase() } : {})
  };

  const res = await fetch(`${baseUrl}/easy-split/vendors`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Failed to create Easy Split vendor: HTTP ${res.status}`);
  }
  return data;
}

/**
 * Update Easy Split vendor details (PUT /easy-split/vendors/{vendor_id})
 */
export async function updateEasySplitVendor(vendorId: string, updateData: Partial<EasySplitVendorParams>): Promise<any> {
  const { baseUrl } = getCredentials();

  const res = await fetch(`${baseUrl}/easy-split/vendors/${encodeURIComponent(vendorId)}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updateData)
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Failed to update Easy Split vendor: HTTP ${res.status}`);
  }
  return data;
}

/**
 * 2. Create Cashfree Order with optional order_splits
 */
export async function createCashfreeOrderSession(params: CreatePaymentSessionParams): Promise<{
  paymentSessionId: string;
  providerOrderId: string;
  orderSplits?: OrderSplitInput[];
}> {
  const { environment, appId, secretKey, baseUrl } = getCredentials();
  const { orderId, amountPaise, customerPhone, customerName, returnUrl, orderSplits } = params;
  const amountRupees = Number((amountPaise / 100).toFixed(2));

  const payload: any = {
    order_id: orderId,
    order_amount: amountRupees,
    order_currency: 'INR',
    customer_details: {
      customer_id: `cust_${orderId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`,
      customer_phone: customerPhone || '9999999999',
      customer_name: customerName || 'Print Customer'
    },
    order_meta: {
      return_url: returnUrl || `${(process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '')}/order-status?order_id=${orderId}`
    }
  };

  // Add order_splits if configured
  if (orderSplits && orderSplits.length > 0) {
    payload.order_splits = orderSplits.map((s) => ({
      vendor_id: s.vendor_id,
      ...(s.percentage !== undefined ? { percentage: s.percentage } : {}),
      ...(s.amount !== undefined ? { amount: Number(s.amount.toFixed(2)) } : {})
    }));
  }

  try {
    const res = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });

    const data: any = await res.json();
    if (!res.ok || !data?.payment_session_id) {
      throw new Error(data?.message || `Cashfree API error status ${res.status}`);
    }

    return {
      paymentSessionId: data.payment_session_id,
      providerOrderId: data.order_id || orderId,
      orderSplits: data.order_splits
    };
  } catch (directErr: any) {
    // Fallback to official SDK if no splits or if direct fetch fails
    if (!orderSplits || orderSplits.length === 0) {
      try {
        const sdk = new Cashfree(environment, appId, secretKey);
        const response = await sdk.PGCreateOrder(payload as any);
        if (response?.data?.payment_session_id) {
          return {
            paymentSessionId: response.data.payment_session_id,
            providerOrderId: response.data.order_id || orderId
          };
        }
      } catch (_) {}
    }

    throw new Error(`Failed to create Cashfree payment session: ${directErr.message}`);
  }
}

/**
 * Split after payment (POST /easy-split/orders/{order_id}/split)
 */
export async function splitAfterPayment(orderId: string, splitDetails: OrderSplitInput[]): Promise<any> {
  const { baseUrl } = getCredentials();

  const res = await fetch(`${baseUrl}/easy-split/orders/${encodeURIComponent(orderId)}/split`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ split: splitDetails })
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Split after payment failed: HTTP ${res.status}`);
  }
  return data;
}

/**
 * 3. Track Settlements & Reconciliation (GET /orders/{order_id}/settlements)
 */
export async function fetchOrderSettlements(orderId: string): Promise<any> {
  const { baseUrl } = getCredentials();

  const res = await fetch(`${baseUrl}/orders/${encodeURIComponent(orderId)}/settlements`, {
    method: 'GET',
    headers: getHeaders()
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Failed to fetch settlements: HTTP ${res.status}`);
  }
  return data;
}

/**
 * 4. Create On Demand Transfer (POST /easy-split/transfers)
 */
export async function createOnDemandTransfer(params: {
  vendorId: string;
  amount: number;
  transferId?: string;
  remarks?: string;
}): Promise<any> {
  const { baseUrl } = getCredentials();

  const payload = {
    vendor_id: params.vendorId,
    amount: Number(params.amount.toFixed(2)),
    transfer_id: params.transferId || `trf_${Date.now()}`,
    remarks: params.remarks || 'Manual payout transfer'
  };

  const res = await fetch(`${baseUrl}/easy-split/transfers`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `On-demand transfer failed: HTTP ${res.status}`);
  }
  return data;
}

/**
 * Manage Refunds with split adjustments (POST /orders/{order_id}/refunds)
 */
export async function createEasySplitRefund(params: {
  orderId: string;
  refundAmount: number;
  refundId?: string;
  refundNote?: string;
  split?: Array<{ vendor_id: string; amount?: number; percentage?: number }>;
}): Promise<any> {
  const { baseUrl } = getCredentials();

  const payload: any = {
    refund_amount: Number(params.refundAmount.toFixed(2)),
    refund_id: params.refundId || `ref_${Date.now()}`,
    refund_note: params.refundNote || 'Customer refund'
  };

  if (params.split && params.split.length > 0) {
    payload.refund_splits = params.split;
  }

  const res = await fetch(`${baseUrl}/orders/${encodeURIComponent(params.orderId)}/refunds`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Refund creation failed: HTTP ${res.status}`);
  }
  return data;
}

/**
 * Sandbox Simulation: Enable Easy Split in sandbox (POST /pg/easy-split/simulation/enable)
 */
export async function enableEasySplitSandboxSimulation(): Promise<any> {
  const { baseUrl } = getCredentials();

  const res = await fetch(`${baseUrl}/easy-split/simulation/enable`, {
    method: 'POST',
    headers: getHeaders()
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Sandbox simulation activation failed: HTTP ${res.status}`);
  }
  return data;
}

export async function fetchCashfreeOrderStatus(orderId: string): Promise<{
  orderStatus: string;
  orderAmount: number;
  cfOrderId?: string;
  paymentDetails?: any;
}> {
  const { baseUrl } = getCredentials();

  const res = await fetch(`${baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: getHeaders()
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Cashfree fetch order failed with status ${res.status}`);
  }

  return {
    orderStatus: data.order_status,
    orderAmount: data.order_amount,
    cfOrderId: String(data.cf_order_id || ''),
    paymentDetails: data
  };
}

export function verifyCashfreeWebhook(signature: string, rawBody: string, timestamp: string): any {
  const { environment, appId, secretKey } = getCredentials();
  const sdk = new Cashfree(environment, appId, secretKey);
  return sdk.PGVerifyWebhookSignature(signature, rawBody, timestamp);
}
