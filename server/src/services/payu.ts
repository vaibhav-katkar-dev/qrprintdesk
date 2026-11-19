import crypto from 'node:crypto';

export interface PayUCredentials {
  merchantKey: string;
  merchantSalt: string;
  clientId: string;
  clientSecret: string;
  isProduction: boolean;
  paymentUrl: string;
  tokenUrl: string;
}

export function getPayUCredentials(): PayUCredentials {
  const isProduction = process.env.PAYU_ENV === 'PRODUCTION';
  const merchantKey = (process.env.PAYU_MERCHANT_KEY || '8BXmrR').trim();
  const merchantSalt = (process.env.PAYU_MERCHANT_SALT || 'USFH2YmEhfmrdiWz3MHhonkwrAmr2ToJ').trim();
  const clientId = (process.env.PAYU_CLIENT_ID || '20a3f832ac940842712e0eb33cdd9e75498e11c5b2c90c75c6fb6f771209a177').trim();
  const clientSecret = (process.env.PAYU_CLIENT_SECRET || 'd5f911752fb6d15af7a23657233826ed1813681ad807e151dac710947a3d9562').trim();

  return {
    merchantKey,
    merchantSalt,
    clientId,
    clientSecret,
    isProduction,
    paymentUrl: isProduction ? 'https://secure.payu.in/_payment' : 'https://test.payu.in/_payment',
    tokenUrl: isProduction ? 'https://accounts.payu.in/oauth/token' : 'https://testaccounts.payu.in/oauth/token'
  };
}

export interface PayUPaymentParams {
  orderId: string;
  amountPaise: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  shopSlug: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

export interface PayUCheckoutPayload {
  key: string;
  txnid: string;
  amount: string; // e.g. "10.00"
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  surl: string;
  furl: string;
  hash: string;
  action: string;
  service_provider: 'payu_paisa';
  udf1: string;
  udf2: string;
  udf3: string;
  udf4: string;
  udf5: string;
}

/**
 * Generate PayU SHA-512 Hash for Checkout Request
 * Formula: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
 */
export function generatePayURequestHash(params: {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  salt: string;
}): string {
  const { key, txnid, amount, productinfo, firstname, email, salt } = params;
  const udf1 = params.udf1 || '';
  const udf2 = params.udf2 || '';
  const udf3 = params.udf3 || '';
  const udf4 = params.udf4 || '';
  const udf5 = params.udf5 || '';

  // PayU standard formula:
  // sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5|udf6|udf7|udf8|udf9|udf10|salt)
  // Between udf5 and salt there are 5 fields (udf6..udf10), requiring 6 separating pipes: ||||||
  const hashString = `${key}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`;
  return crypto.createHash('sha512').update(hashString).digest('hex').toLowerCase();
}

/**
 * Verify PayU SHA-512 Reverse Hash on Webhook or Return Response
 * Formula without additionalCharges:
 *   sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 * Formula with additionalCharges:
 *   sha512(additionalCharges|SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
export function verifyPayUResponseHash(params: {
  receivedHash: string;
  status: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  key: string;
  salt: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  additionalCharges?: string;
}): boolean {
  const { receivedHash, status, txnid, amount, productinfo, firstname, email, key, salt, additionalCharges } = params;
  const udf1 = params.udf1 || '';
  const udf2 = params.udf2 || '';
  const udf3 = params.udf3 || '';
  const udf4 = params.udf4 || '';
  const udf5 = params.udf5 || '';

  // PayU response formula has 6 pipes between status and udf5 for empty udf10..udf6: ||||||
  let hashString: string;
  if (additionalCharges && additionalCharges.trim() !== '') {
    hashString = `${additionalCharges}|${salt}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;
  } else {
    hashString = `${salt}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;
  }

  const calculatedHash = crypto.createHash('sha512').update(hashString).digest('hex').toLowerCase();
  return calculatedHash === (receivedHash || '').toLowerCase();
}

/**
 * Create PayU Checkout Parameters for Customer PWA
 */
export function createPayUCheckoutParams(params: PayUPaymentParams): PayUCheckoutPayload {
  const creds = getPayUCredentials();
  const amountRupees = (params.amountPaise / 100).toFixed(2);
  const txnid = params.orderId;
  const productinfo = 'QrPrintDesk Counter Print';
  const firstname = (params.customerName || 'Customer').trim().replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 30) || 'Customer';
  const email = (params.customerEmail || 'qrprintdesk@gmail.com').trim();
  const phone = (params.customerPhone || '9999999999').replace(/[^0-9]/g, '').slice(-10) || '9999999999';

  const baseUrl = (process.env.SERVER_BASE_URL || process.env.SERVER_URL || 'https://print.qrprintdesk.in').replace(/\/+$/, '');
  const surl = `${baseUrl}/api/payu/response?shop=${encodeURIComponent(params.shopSlug)}`;
  const furl = `${baseUrl}/api/payu/response?shop=${encodeURIComponent(params.shopSlug)}`;

  const udf1 = params.shopSlug;
  const udf2 = params.udf2 || '';
  const udf3 = params.udf3 || '';
  const udf4 = params.udf4 || '';
  const udf5 = params.udf5 || '';

  const hash = generatePayURequestHash({
    key: creds.merchantKey,
    txnid,
    amount: amountRupees,
    productinfo,
    firstname,
    email,
    udf1,
    udf2,
    udf3,
    udf4,
    udf5,
    salt: creds.merchantSalt
  });

  return {
    key: creds.merchantKey,
    txnid,
    amount: amountRupees,
    productinfo,
    firstname,
    email,
    phone,
    surl,
    furl,
    hash,
    action: creds.paymentUrl,
    service_provider: 'payu_paisa',
    udf1,
    udf2,
    udf3,
    udf4,
    udf5
  };
}
