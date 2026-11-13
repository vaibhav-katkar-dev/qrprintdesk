import crypto from 'node:crypto';
import { Db, ObjectId } from 'mongodb';
import { AgentDocument, ShopDocument } from '../types.js';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSecureToken(prefix: string = 'agt_'): { secret: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const secret = `${prefix}${raw}`;
  const hash = hashToken(secret);
  return { secret, hash };
}

export async function authenticateAgent(
  db: Db,
  token: string
): Promise<{ success: boolean; agent?: AgentDocument; error?: string }> {
  if (!token) {
    return { success: false, error: 'Missing agent authentication token' };
  }

  const tokenHash = hashToken(token.trim());
  const agent = await db.collection<AgentDocument>('agents').findOne({
    tokenHash,
    isRevoked: false
  });

  if (!agent) {
    return { success: false, error: 'Invalid or revoked agent token' };
  }

  return { success: true, agent };
}

export async function authenticateShop(
  db: Db,
  shopSlugOrId: string,
  pin: string
): Promise<{ success: boolean; shop?: ShopDocument; error?: string }> {
  const query: any = ObjectId.isValid(shopSlugOrId)
    ? { _id: new ObjectId(shopSlugOrId), isActive: true }
    : { slug: shopSlugOrId, isActive: true };

  const shop = await db.collection<ShopDocument>('shops').findOne(query);
  if (!shop) {
    return { success: false, error: 'Shop not found or inactive' };
  }

  const pinHash = hashToken(pin);
  if (shop.pinHash !== pinHash) {
    return { success: false, error: 'Invalid credentials' };
  }

  return { success: true, shop };
}
