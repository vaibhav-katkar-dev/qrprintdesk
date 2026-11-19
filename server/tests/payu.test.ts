import { describe, it, expect } from 'vitest';
import { generatePayURequestHash, verifyPayUResponseHash, createPayUCheckoutParams } from '../src/services/payu.js';
import crypto from 'node:crypto';

describe('PayU Service', () => {
  const key = '8BXmrR';
  const salt = 'USFH2YmEhfmrdiWz3MHhonkwrAmr2ToJ';

  it('generates a valid SHA-512 request hash matching PayU formula', () => {
    const params = {
      key,
      txnid: 'ord_test_123',
      amount: '10.00',
      productinfo: 'QrPrintDesk Counter Print',
      firstname: 'Rahul',
      email: 'rahul@example.com',
      udf1: 'default',
      salt
    };

    const hash = generatePayURequestHash(params);
    expect(hash).toHaveLength(128); // 128 hex chars for SHA-512

    // Manually verify expected SHA-512 calculation with 10 total pipes between udf1 and salt
    const expectedRaw = `${key}|ord_test_123|10.00|QrPrintDesk Counter Print|Rahul|rahul@example.com|default||||||||||${salt}`;
    const expectedHash = crypto.createHash('sha512').update(expectedRaw).digest('hex').toLowerCase();
    expect(hash).toBe(expectedHash);
  });

  it('matches exact PayU server verified transaction hash from production error response', () => {
    const params = {
      key: '8BXmrR',
      txnid: 'ord_1795067022506_e98224cc',
      amount: '1.00',
      productinfo: 'QrPrintDesk Counter Print',
      firstname: 'Customer',
      email: 'qrprintdesk@gmail.com',
      udf1: 'vaibhav-s-shop',
      salt: 'USFH2YmEhfmrdiWz3MHhonkwrAmr2ToJ'
    };

    const hash = generatePayURequestHash(params);
    expect(hash).toBe('d0252cedbfb373ba3cfcea19635b70be14a241788eba02bc8956a8ec9ba10d61301055977e5b84dfdca86c69465209c2d5d56689b991f7fdac80759725b6ec27');
  });

  it('verifies valid reverse SHA-512 hash on PayU webhook response', () => {
    const status = 'success';
    const txnid = 'ord_test_123';
    const amount = '10.00';
    const productinfo = 'QrPrintDesk Counter Print';
    const firstname = 'Rahul';
    const email = 'rahul@example.com';
    const udf1 = 'default';

    // Reverse hash formula: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
    // When udf2..udf5 are empty and udf1 is 'default', there are 10 pipes between status and udf1
    const reverseRaw = `${salt}|${status}||||||||||${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;
    const receivedHash = crypto.createHash('sha512').update(reverseRaw).digest('hex').toLowerCase();

    const isValid = verifyPayUResponseHash({
      receivedHash,
      status,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      key,
      salt,
      udf1
    });

    expect(isValid).toBe(true);
  });

  it('rejects tampered or invalid PayU hash', () => {
    const isValid = verifyPayUResponseHash({
      receivedHash: 'bad_hash_123',
      status: 'success',
      txnid: 'ord_test_123',
      amount: '10.00',
      productinfo: 'QrPrintDesk Counter Print',
      firstname: 'Rahul',
      email: 'rahul@example.com',
      key,
      salt
    });

    expect(isValid).toBe(false);
  });

  it('generates complete PayU checkout payload with test endpoint', () => {
    const payload = createPayUCheckoutParams({
      orderId: 'ord_sample_999',
      amountPaise: 2500, // Rs 25.00
      customerName: 'Aarav Sharma',
      customerPhone: '9876543210',
      shopSlug: 'default'
    });

    expect(payload.key).toBe(key);
    expect(payload.txnid).toBe('ord_sample_999');
    expect(payload.amount).toBe('25.00');
    expect(payload.firstname).toBe('Aarav Sharma');
    expect(payload.phone).toBe('9876543210');
    expect(payload.action).toContain('payu.in');
    expect(payload.hash).toHaveLength(128);
    expect(payload.udf1).toBe('default');
  });
});
