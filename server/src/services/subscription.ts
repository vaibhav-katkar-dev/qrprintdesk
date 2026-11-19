import { Db, ObjectId } from 'mongodb';
import { ShopDocument, VendorSubscription } from '../types.js';

export interface PlanConfig {
  id: 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  name: string;
  monthlyPriceRupees: number;
  yearlyPriceRupees: number;
  monthlyOrderLimit: number;
  features: string[];
  popular?: boolean;
}

export const VENDOR_PLANS: Record<string, PlanConfig> = {
  FREE: {
    id: 'FREE',
    name: 'Free Starter Trial',
    monthlyPriceRupees: 0,
    yearlyPriceRupees: 0,
    monthlyOrderLimit: 100,
    features: [
      'Up to 100 orders / month',
      '1 Windows Desktop Print Station',
      'Official Counter QR Standee',
      'UPI QR & Cash at Counter mode',
      '24-Hour document auto-purge',
      'Email support assistance'
    ]
  },
  STARTER: {
    id: 'STARTER',
    name: 'Starter Xerox',
    monthlyPriceRupees: 149,
    yearlyPriceRupees: 1299,
    monthlyOrderLimit: 500,
    features: [
      'Up to 500 orders / month',
      'Automated FIFO print spooling',
      'Duplex & B&W setting control',
      'Daily order & page counter',
      'Email support assistance'
    ]
  },
  GROWTH: {
    id: 'GROWTH',
    name: 'Growth Shop',
    monthlyPriceRupees: 349,
    yearlyPriceRupees: 2999,
    monthlyOrderLimit: 1500,
    popular: true,
    features: [
      'Up to 1,500 orders / month',
      'Real-time rush hour & sales analytics',
      'Daily automated bank payout setup',
      'Priority FIFO spooling queue',
      'Itemized settlement ledger',
      'Dedicated onboarding assistance'
    ]
  },
  ENTERPRISE: {
    id: 'ENTERPRISE',
    name: 'High-Volume Pro',
    monthlyPriceRupees: 699,
    yearlyPriceRupees: 5999,
    monthlyOrderLimit: 999999,
    features: [
      'Unlimited orders / month',
      'Multi-printer routing support',
      'Complete historical sales ledger',
      'High-capacity spool queueing',
      'WhatsApp document intake ready',
      'Priority developer support'
    ]
  }
};

/**
 * Get current year-month string, e.g. "2026-11"
 */
function getCurrentMonthStr(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Retrieve or initialize shop subscription with automated monthly order reset
 */
export async function getShopSubscription(db: Db, shopId: ObjectId | string): Promise<{
  subscription: VendorSubscription;
  planConfig: PlanConfig;
  usagePercent: number;
  isNearLimit: boolean;
  isLimitReached: boolean;
  graceRemaining: number;
  canPrint: boolean;
}> {
  const sId = typeof shopId === 'string' ? new ObjectId(shopId) : shopId;
  const shop = await db.collection<ShopDocument>('shops').findOne({ _id: sId });

  const now = new Date();
  const currentMonthStr = getCurrentMonthStr();

  let sub: VendorSubscription;

  if (!shop?.subscription) {
    // Default initial Free Trial plan
    sub = {
      plan: 'FREE',
      billingCycle: 'monthly',
      status: 'TRIAL',
      startDate: now,
      expiryDate: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000), // 1 year free trial
      monthlyOrderLimit: 100,
      ordersThisMonth: 0,
      lastResetMonth: currentMonthStr,
      graceOrdersAllowed: 10
    };

    await db.collection<ShopDocument>('shops').updateOne(
      { _id: sId },
      { $set: { subscription: sub, updatedAt: now } }
    );
  } else {
    sub = { ...shop.subscription };

    // Check for monthly rollover reset
    if (sub.lastResetMonth !== currentMonthStr) {
      sub.ordersThisMonth = 0;
      sub.lastResetMonth = currentMonthStr;

      await db.collection<ShopDocument>('shops').updateOne(
        { _id: sId },
        {
          $set: {
            'subscription.ordersThisMonth': 0,
            'subscription.lastResetMonth': currentMonthStr,
            updatedAt: now
          }
        }
      );
    }
  }

  const planConfig = VENDOR_PLANS[sub.plan] || VENDOR_PLANS.FREE;
  const limit = sub.monthlyOrderLimit || planConfig.monthlyOrderLimit;
  const used = sub.ordersThisMonth || 0;
  const grace = sub.graceOrdersAllowed ?? 10;

  const usagePercent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const isNearLimit = used >= Math.floor(limit * 0.8) && used < limit;
  const isLimitReached = used >= limit;
  const graceRemaining = Math.max(0, limit + grace - used);
  const canPrint = used < limit + grace;

  return {
    subscription: sub,
    planConfig,
    usagePercent,
    isNearLimit,
    isLimitReached,
    graceRemaining,
    canPrint
  };
}

/**
 * Increment orders processed by shop this month
 */
export async function incrementShopOrderCount(db: Db, shopId: ObjectId | string): Promise<void> {
  const sId = typeof shopId === 'string' ? new ObjectId(shopId) : shopId;
  const currentMonthStr = getCurrentMonthStr();

  await db.collection<ShopDocument>('shops').updateOne(
    { _id: sId },
    {
      $inc: { 'subscription.ordersThisMonth': 1 },
      $set: { 'subscription.lastResetMonth': currentMonthStr, updatedAt: new Date() }
    }
  );
}

/**
 * Upgrade shop subscription upon successful payment
 */
export async function upgradeShopSubscription(params: {
  db: Db;
  shopId: ObjectId | string;
  planId: 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  billingCycle: 'monthly' | 'yearly';
  paymentTxnId: string;
}): Promise<VendorSubscription> {
  const { db, planId, billingCycle, paymentTxnId } = params;
  const sId = typeof params.shopId === 'string' ? new ObjectId(params.shopId) : params.shopId;

  const plan = VENDOR_PLANS[planId];
  if (!plan) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }

  const now = new Date();
  const durationDays = billingCycle === 'yearly' ? 365 : 30;
  const expiryDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
  const currentMonthStr = getCurrentMonthStr();

  const newSub: VendorSubscription = {
    plan: planId,
    billingCycle,
    status: 'ACTIVE',
    startDate: now,
    expiryDate,
    monthlyOrderLimit: plan.monthlyOrderLimit,
    ordersThisMonth: 0, // Fresh count on upgrade
    lastResetMonth: currentMonthStr,
    graceOrdersAllowed: 25,
    lastUpgradeDate: now,
    lastPaymentTxnId: paymentTxnId
  };

  await db.collection<ShopDocument>('shops').updateOne(
    { _id: sId },
    {
      $set: {
        subscription: newSub,
        updatedAt: now
      }
    }
  );

  return newSub;
}
