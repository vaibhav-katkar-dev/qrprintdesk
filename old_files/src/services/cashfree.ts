import { Cashfree, CFEnvironment } from 'cashfree-pg';

const isProduction = process.env.CASHFREE_ENV === 'PRODUCTION';
const environment = isProduction ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
const appId = process.env.CASHFREE_APP_ID || 'TEST_APP_ID';
const secretKey = process.env.CASHFREE_SECRET_KEY || 'TEST_SECRET_KEY';

export const cashfree = new Cashfree(
  environment,
  appId,
  secretKey
);

export interface CreatePaymentSessionParams {
  orderId: string;
  amountPaise: number;
  customerPhone?: string;
  customerName?: string;
  returnUrl?: string;
}

export async function createCashfreeOrderSession(params: CreatePaymentSessionParams): Promise<{
  paymentSessionId: string;
  providerOrderId: string;
}> {
  const { orderId, amountPaise, customerPhone, customerName, returnUrl } = params;
  const amountRupees = amountPaise / 100;

  const request = {
    order_id: orderId,
    order_amount: amountRupees,
    order_currency: 'INR',
    customer_details: {
      customer_id: `cust_${orderId.slice(0, 16)}`,
      customer_phone: customerPhone || '9999999999',
      customer_name: customerName || 'Print Customer'
    },
    order_meta: {
      return_url: returnUrl || `https://print.local/order-status?order_id=${orderId}`
    }
  };

  const response = await cashfree.PGCreateOrder(request);
  const data = response.data;

  if (!data?.payment_session_id) {
    throw new Error('Cashfree response missing payment_session_id');
  }

  return {
    paymentSessionId: data.payment_session_id,
    providerOrderId: data.order_id || orderId
  };
}

export function verifyCashfreeWebhook(signature: string, rawBody: string, timestamp: string): any {
  // Uses Cashfree SDK's official PGVerifyWebhookSignature
  return cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
}
