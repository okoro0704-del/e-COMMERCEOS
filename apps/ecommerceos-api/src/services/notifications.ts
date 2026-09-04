import { getLifeOsMessagingProvider } from "./lifeos/container.js";
import { prisma } from "../db.js";
import { writeAudit } from "../lib/audit.js";

export async function notifyOrderStatus(opts: {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  buyerTrustId: string;
  buyerPhone?: string | null;
  status: string;
  message: string;
}) {
  const messaging = getLifeOsMessagingProvider();
  const store = await prisma.storeConfig.findUnique({ where: { tenantId: opts.tenantId } });
  const body = opts.message
    .replaceAll("{orderNumber}", opts.orderNumber)
    .replaceAll("{storeName}", store?.storeName ?? "store")
    .replaceAll("{status}", opts.status);

  const chat = await messaging.sendMessage({
    ownerTrustId: opts.buyerTrustId,
    threadId: `order:${opts.orderId}`,
    channel: "chat",
    body,
  });

  let sms: { messageId: string } | undefined;
  if (opts.buyerPhone) {
    sms = await messaging.sendMessage({
      ownerTrustId: opts.buyerTrustId,
      threadId: `sms:${opts.buyerPhone}`,
      channel: "sms",
      body,
    });
  }

  const result = { chatMessageId: chat.messageId, smsMessageId: sms?.messageId };
  await writeAudit({
    tenantId: opts.tenantId,
    actorKind: "system",
    action: "elfcom.notify",
    resource: "order",
    resourceId: opts.orderId,
    metadata: { status: opts.status, ...result, body },
  });
  return result;
}
