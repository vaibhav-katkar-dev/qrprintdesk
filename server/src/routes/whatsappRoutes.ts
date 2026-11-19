import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { uploadBufferToStorage, generateFileKey } from '../services/r2.js';
import { WebSocketHub } from '../services/wsHub.js';
import { outboxBus } from '../services/outboxWorker.js';
import { incrementShopOrderCount } from '../services/subscription.js';
import { OrderDocument, JobDocument, OutboxDocument, ShopDocument } from '../types.js';

interface WhatsAppMediaMetadata {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
}

/**
 * Send an outbound WhatsApp text message via Meta Cloud API
 */
async function sendWhatsAppReply(
  phoneNumberId: string,
  to: string,
  text: string,
  accessToken: string
): Promise<void> {
  if (!phoneNumberId || !to || !accessToken) return;
  try {
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text }
      })
    });
  } catch (err: any) {
    // Non-fatal logging for outbound WhatsApp notifications
    console.error('[WhatsApp] Failed to send outbound WhatsApp reply:', err?.message || err);
  }
}

/**
 * Fetch media binary buffer from Meta Graph API
 */
async function fetchWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<{ buffer: Buffer; mimeType: string; fileSize: number } | null> {
  try {
    // Step 1: Retrieve media download URL from Meta
    const metaUrl = `https://graph.facebook.com/v18.0/${mediaId}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!metaRes.ok) {
      console.error(`[WhatsApp] Failed to get media URL for ${mediaId}: ${metaRes.status} ${metaRes.statusText}`);
      return null;
    }

    const mediaInfo = (await metaRes.json()) as WhatsAppMediaMetadata;
    if (!mediaInfo.url) {
      console.error(`[WhatsApp] No download URL returned for media ${mediaId}`);
      return null;
    }

    // Step 2: Download binary data
    const downloadRes = await fetch(mediaInfo.url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'curl/7.64.1'
      }
    });

    if (!downloadRes.ok) {
      console.error(`[WhatsApp] Failed to download media from ${mediaInfo.url}: ${downloadRes.status}`);
      return null;
    }

    const arrayBuffer = await downloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      mimeType: mediaInfo.mime_type || 'application/octet-stream',
      fileSize: buffer.length
    };
  } catch (err: any) {
    console.error(`[WhatsApp] Exception downloading media ${mediaId}:`, err?.message || err);
    return null;
  }
}

export const whatsappRoutes: FastifyPluginAsync<{ db: Db; wsHub?: WebSocketHub }> = async (fastify, opts) => {
  const { db, wsHub } = opts;

  // ── Verification Endpoint for Meta Webhook Registration ────────────────────
  fastify.get('/whatsapp/webhook', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || 'qrprintdesk_wa_webhook_2026').trim();

    if (mode === 'subscribe' && token === expectedToken) {
      request.log.info('[WhatsApp] Webhook verified successfully with Meta.');
      return reply.code(200).type('text/plain').send(challenge);
    }

    request.log.warn({ receivedToken: token, expectedToken }, '[WhatsApp] Webhook verification token mismatch');
    return reply.code(403).send('Forbidden: Invalid verification token');
  });

  // ── Event Webhook Endpoint for Incoming WhatsApp Messages ──────────────────
  fastify.post('/whatsapp/webhook', async (request, reply) => {
    // Always immediately acknowledge receipt to Meta to prevent duplicate delivery retries
    reply.code(200).send('EVENT_RECEIVED');

    try {
      // Feature flag: keep silent and inactive until vendor/admin explicitly enables it
      const isEnabled = (process.env.WHATSAPP_ENABLED || 'false').toLowerCase() === 'true';
      if (!isEnabled) {
        request.log.debug('[WhatsApp] Webhook event received but WHATSAPP_ENABLED is not true; skipping processing');
        return;
      }

      const payload = request.body as any;
      if (!payload || payload.object !== 'whatsapp_business_account') {
        return;
      }

      const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
      if (!accessToken) {
        request.log.warn('[WhatsApp] WHATSAPP_ACCESS_TOKEN not configured in server environment');
        return;
      }

      const entries = payload.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const val = change.value;
          if (!val || val.messaging_product !== 'whatsapp') continue;

          const metadata = val.metadata || {};
          const phoneNumberId = metadata.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
          const contacts = val.contacts || [];
          const messages = val.messages || [];

          for (const msg of messages) {
            try {
              const from = msg.from; // Customer WhatsApp phone number
              const contactName = contacts.find((c: any) => c.wa_id === from)?.profile?.name || 'WhatsApp Customer';

              // 1. Customer sent text message (e.g. "Hi", "Print my file")
              if (msg.type === 'text') {
                await sendWhatsAppReply(
                  phoneNumberId,
                  from,
                  `👋 Hello *${contactName}*!\n\nWelcome to *QrPrintDesk* print service.\n\n📄 To print a document, simply send your **PDF**, **Word doc**, or **Image** directly in this chat.\n\nOur system will automatically receive it and queue it at the shop counter!`,
                  accessToken
                );
                continue;
              }

              // 2. Customer sent document or image
              const isDoc = msg.type === 'document';
              const isImg = msg.type === 'image';

              if (!isDoc && !isImg) {
                // Unhandled media types (e.g., audio, sticker, location)
                await sendWhatsAppReply(
                  phoneNumberId,
                  from,
                  `ℹ️ We can only print PDF documents and images (JPG/PNG). Please send your document as a PDF or photo.`,
                  accessToken
                );
                continue;
              }

              const mediaObj = isDoc ? msg.document : msg.image;
              const mediaId = mediaObj?.id;

              if (!mediaId) {
                request.log.warn('[WhatsApp] Received media message with no media ID');
                continue;
              }

              // Download binary from Meta
              const media = await fetchWhatsAppMedia(mediaId, accessToken);
              if (!media || !media.buffer || media.buffer.length === 0) {
                await sendWhatsAppReply(
                  phoneNumberId,
                  from,
                  `⚠️ We couldn't download your attachment. Please try sending the document again.`,
                  accessToken
                );
                continue;
              }

              // Determine filename & extension
              let filename = (mediaObj.filename || '').trim();
              if (!filename) {
                const ext = isDoc ? 'pdf' : (media.mimeType.includes('png') ? 'png' : 'jpg');
                filename = `WhatsApp_${isDoc ? 'Doc' : 'Photo'}_${Date.now()}.${ext}`;
              }
              const fileExtension = path.extname(filename).replace(/^\./, '').toLowerCase() || (isDoc ? 'pdf' : 'jpg');

              // Extract exact page count if PDF, otherwise 1
              let pageCount = 1;
              if (media.mimeType.includes('pdf') || fileExtension === 'pdf') {
                try {
                  const pdfDoc = await PDFDocument.load(media.buffer, { ignoreEncryption: true });
                  pageCount = Math.max(1, pdfDoc.getPageCount());
                } catch (err) {
                  request.log.warn({ err }, '[WhatsApp] Could not parse PDF page count, defaulting to 1');
                  pageCount = 1;
                }
              }

              // 3. Resolve destination shop
              let shop: ShopDocument | null = null;
              if (phoneNumberId) {
                shop = await db.collection<ShopDocument>('shops').findOne({
                  $or: [
                    { waPhoneNumberId: phoneNumberId },
                    { 'printOptions.waPhoneNumberId': phoneNumberId }
                  ],
                  isActive: true
                } as any);
              }

              if (!shop && process.env.WHATSAPP_DEFAULT_SHOP_SLUG) {
                shop = await db.collection<ShopDocument>('shops').findOne({
                  slug: process.env.WHATSAPP_DEFAULT_SHOP_SLUG,
                  isActive: true
                });
              }

              if (!shop) {
                // Fallback to first active shop in database
                shop = await db.collection<ShopDocument>('shops').findOne({ isActive: true });
              }

              if (!shop) {
                request.log.warn('[WhatsApp] No active shop found to route WhatsApp order');
                continue;
              }

              // 4. Upload document to B2 / Storage
              const fileKey = generateFileKey(shop._id.toString(), fileExtension);
              try {
                await uploadBufferToStorage(fileKey, media.buffer, media.mimeType);
              } catch (storageErr: any) {
                request.log.error({ storageErr }, '[WhatsApp] Failed to save document to storage');
                await sendWhatsAppReply(
                  phoneNumberId,
                  from,
                  `❌ Failed to store document. Please try again or inform the shopkeeper.`,
                  accessToken
                );
                continue;
              }

              // 5. Calculate Pricing (Pay at Counter standard rates)
              const bwRate = shop.pricing?.bwPerPagePaise ?? 200;
              const grossPaise = bwRate * pageCount;
              const platformFeePercent = shop.easySplit?.commissionPercent ?? 5;
              const platformFeePaise = Math.round((grossPaise * platformFeePercent) / 100);
              const vendorSharePaise = grossPaise - platformFeePaise;

              const orderId = `ord_wa_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
              const tokenShort = orderId.slice(-4).toUpperCase();
              const now = new Date();
              const retentionUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

              // 6. Create Order Document in MongoDB
              const orderDoc: OrderDocument = {
                _id: new ObjectId(),
                orderId,
                shopId: shop._id,
                customerName: contactName,
                customerPhone: from,
                files: [
                  {
                    fileKey,
                    originalFilename: filename,
                    fileSize: media.fileSize,
                    mimeType: media.mimeType,
                    pageCount
                  }
                ],
                printOptions: {
                  copies: 1,
                  colorMode: 'monochrome',
                  duplexMode: 'simplex',
                  paperSize: 'A4',
                  fitMode: 'fit',
                  orientation: 'portrait',
                  pagesPerSheet: 1
                },
                pricing: {
                  amountPaise: grossPaise,
                  platformFeePaise,
                  vendorSharePaise,
                  currency: 'INR'
                },
                status: 'PAY_AT_COUNTER_PENDING',
                payAtCounter: true,
                retentionUntil,
                auditTrail: [
                  {
                    actor: 'customer',
                    from: 'UPLOADED',
                    to: 'PAY_AT_COUNTER_PENDING',
                    time: now,
                    reason: `Received via WhatsApp from ${from} (${contactName})`
                  }
                ],
                createdAt: now,
                updatedAt: now
              };

              await db.collection<OrderDocument>('orders').insertOne(orderDoc);
              await incrementShopOrderCount(db, shop._id);

              // 7. Create Job Document in MongoDB
              const jobId = `job_${orderDoc.orderId}`;
              const jobDoc: JobDocument = {
                _id: new ObjectId(),
                jobId,
                orderId: orderDoc.orderId,
                shopId: shop._id,
                status: 'QUEUED',
                retryCount: 0,
                auditTrail: [
                  {
                    actor: 'system',
                    from: 'PAY_AT_COUNTER_PENDING',
                    to: 'QUEUED',
                    time: now,
                    reason: 'WhatsApp print document queued for counter pickup'
                  }
                ],
                createdAt: now,
                updatedAt: now
              };

              await db.collection<JobDocument>('jobs').insertOne(jobDoc);

              // 8. Insert Outbox Entry & Trigger Instant Worker Wakeup
              await db.collection<OutboxDocument>('outbox').insertOne({
                _id: new ObjectId(),
                jobId,
                shopId: shop._id,
                payload: {
                  type: 'job',
                  id: jobId,
                  op: 'PRINT_JOB',
                  payAtCounter: true
                },
                status: 'PENDING',
                attempts: 0,
                nextAttemptAt: now,
                createdAt: now,
                updatedAt: now
              });

              // Instant wake-up for Outbox worker (< 15ms latency)
              outboxBus.emit('outbox:new');

              // Send WebSocket hint directly to active desktop vendor agent
              if (wsHub) {
                wsHub.sendJobHint(shop._id.toString(), jobId);
              }

              request.log.info(
                { orderId, jobId, shopSlug: shop.slug, pages: pageCount, file: filename },
                '[WhatsApp] Order successfully queued for counter print'
              );

              // 9. Send WhatsApp Confirmation to Customer
              const costRupees = (grossPaise / 100).toFixed(2);
              await sendWhatsAppReply(
                phoneNumberId,
                from,
                `✅ *Document Queued for Print!*\n\n📄 *File:* ${filename}\n📑 *Pages:* ${pageCount}\n🏷️ *Token:* #${tokenShort}\n💰 *Amount:* ₹${costRupees} (Pay at Counter)\n\n📍 Your print is being prepared at *${shop.name}*. Please visit the counter and share your token *#${tokenShort}* to collect your print.`,
                accessToken
              );
            } catch (msgErr: any) {
              request.log.error({ msgErr }, '[WhatsApp] Error processing individual message item');
            }
          }
        }
      }
    } catch (globalErr: any) {
      request.log.error({ globalErr }, '[WhatsApp] Uncaught error in WhatsApp webhook handler');
    }
  });
};
