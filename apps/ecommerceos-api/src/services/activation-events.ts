import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { writeAudit } from "../lib/audit.js";
import { portalAuthorization } from "./portal-registration.js";
import { businessIdOf, installIdOf } from "./store-identity.js";

/**
 * Store activation changes reported to LifeOS Portal (POST /internal/ecommerceos/activation-events),
 * signed with eCommerceOS's key and Idempotency-Key "eco-activation:<eventId>". Each change takes the
 * store's next version in the same transaction as the change, so Portal can apply events in order,
 * ignore duplicates and late arrivals, and see a missed one by comparing versions with the status
 * endpoint. "pending" and "legacy" never mean a licence was paid: "active" means a Digiconomy
 * operator verified the setup payment. Every delivery outcome is recorded, never assumed.
 */
const ACTIVATION_EVENTS_PATH = "/internal/ecommerceos/activation-events";

type Tx = Prisma.TransactionClient;
export type ActivationCause = "created" | "verified" | "reversed";
type Delivery = "delivered" | "failed" | "rejected" | "conflict" | "pending";

async function recordEvent(tx: Tx, tenantId: string, cause: ActivationCause) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { portalInstall: true } });
  const id = randomUUID();
  const occurredAt = new Date();
  const body = JSON.stringify({
    eventId: id,
    version: tenant.activationVersion,
    tenantId: tenant.id,
    installId: installIdOf(tenant),
    businessId: businessIdOf(tenant),
    subdomain: tenant.slug,
    status: tenant.activationStatus,
    cause,
    occurredAt: occurredAt.toISOString(),
  });
  await tx.activationEvent.create({
    data: { id, tenantId: tenant.id, version: tenant.activationVersion, status: tenant.activationStatus, cause, occurredAt, body },
  });
  return id;
}

/**
 * Sets a store's activation status (only from `from`, when given) and records the change, inside the
 * caller's transaction. Returns the event id, or null when the store was not in `from`.
 */
export async function changeActivationStatus(tx: Tx, tenantId: string, status: string, cause: ActivationCause, from?: string) {
  const updated = await tx.tenant.updateMany({
    where: { id: tenantId, ...(from ? { activationStatus: from } : {}) },
    data: { activationStatus: status, activationVersion: { increment: 1 } },
  });
  if (updated.count !== 1) return null;
  return recordEvent(tx, tenantId, cause);
}

/** Version 1 of a new store: its initial status ("pending" or "legacy", never paid). */
export async function recordInitialActivation(tenantId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { activationVersion: 1 } });
    return recordEvent(tx, tenantId, "created");
  });
}

async function record(id: string, delivery: Delivery, detail: { httpStatus?: number; error?: string; attempted: boolean }) {
  const row = await prisma.activationEvent.update({
    where: { id },
    data: {
      delivery,
      httpStatus: detail.httpStatus ?? null,
      lastError: detail.error ?? null,
      ...(detail.attempted ? { attempts: { increment: 1 }, lastAttemptAt: new Date() } : {}),
      ...(delivery === "delivered" ? { deliveredAt: new Date() } : {}),
    },
  });
  await writeAudit({
    tenantId: row.tenantId,
    actorKind: "system",
    action: "portal.activation_event",
    resource: "activation_event",
    resourceId: id,
    metadata: { version: row.version, status: row.status, outcome: delivery, httpStatus: detail.httpStatus ?? null, error: detail.error ?? null },
  });
  return delivery;
}

/**
 * Sends (or re-sends) one stored event. Delivered and conflicting events are left alone; a rejected one
 * only when asked (after Portal's receiver or permission was put right).
 */
export async function sendActivationEvent(id: string, opts: { retryRejected?: boolean } = {}): Promise<Delivery> {
  const row = await prisma.activationEvent.findUnique({ where: { id } });
  if (!row) return "failed";
  if (row.delivery === "delivered" || row.delivery === "conflict") return row.delivery as Delivery;
  if (row.delivery === "rejected" && !opts.retryRejected) return "rejected";
  if (!config.portalApiUrl) return record(id, "pending", { error: "portal_api_unconfigured", attempted: false });
  const target = new URL(`${config.portalApiUrl}${ACTIVATION_EVENTS_PATH}`);
  const idempotencyKey = `eco-activation:${id}`;
  // Signed only: this call never travels on the shared token.
  const authorization = portalAuthorization(target.pathname, row.body, idempotencyKey);
  if (!authorization) return record(id, "pending", { error: "signing_unconfigured", attempted: false });
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", accept: "application/json", "idempotency-key": idempotencyKey },
      body: row.body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 200 || res.status === 201) return record(id, "delivered", { httpStatus: res.status, attempted: true });
    // 409: Portal holds a different state for this version; an operator reconciles it.
    if (res.status === 409) return record(id, "conflict", { httpStatus: res.status, error: payload.error ?? "http_409", attempted: true });
    // Other client errors are Portal refusing the event (unknown install, scope): re-sending won't help.
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    return record(id, retryable ? "failed" : "rejected", { httpStatus: res.status, error: payload.error ?? `http_${res.status}`, attempted: true });
  } catch (err) {
    const timeout = (err as { name?: string }).name === "TimeoutError";
    return record(id, "failed", { error: timeout ? "portal_timeout" : "portal_unreachable", attempted: true });
  }
}

/** After the change committed: deliver without holding up the caller; the outcome is still recorded. */
export function sendActivationEventsInBackground(ids: Array<string | null | undefined>) {
  for (const id of ids) if (id) void sendActivationEvent(id).catch(() => undefined);
}

/**
 * Re-sends every undelivered, retryable event, oldest version first per store. includeRejected also
 * re-sends events Portal refused, for after its receiver or permission was put right (for example,
 * events sent before Portal's release). Conflicts are never re-sent: an operator reconciles them.
 */
export async function resendActivationEvents(operatorId: string, opts: { includeRejected?: boolean } = {}) {
  const due = await prisma.activationEvent.findMany({
    where: { delivery: { in: opts.includeRejected ? ["pending", "failed", "rejected"] : ["pending", "failed"] } },
    orderBy: [{ tenantId: "asc" }, { version: "asc" }],
  });
  const outcomes: Record<Delivery, number> = { delivered: 0, failed: 0, rejected: 0, conflict: 0, pending: 0 };
  for (const row of due) outcomes[await sendActivationEvent(row.id, { retryRejected: opts.includeRejected })] += 1;
  const summary = { attempted: due.length, includeRejected: Boolean(opts.includeRejected), ...outcomes };
  await writeAudit({
    actorKind: "platform_operator",
    actorId: operatorId,
    action: "platform.activation_event_resend",
    resource: "activation_event",
    metadata: summary,
  });
  return summary;
}

export async function listActivationEvents() {
  const rows = await prisma.activationEvent.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { tenant: { select: { slug: true } } } });
  return {
    events: rows.map((r) => ({
      eventId: r.id,
      subdomain: r.tenant.slug,
      version: r.version,
      status: r.status,
      cause: r.cause,
      occurredAt: r.occurredAt.toISOString(),
      delivery: r.delivery,
      httpStatus: r.httpStatus,
      attempts: r.attempts,
      lastError: r.lastError,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    })),
  };
}

/** For the status endpoint: the store's activation version and when it last changed. */
export async function activationVersionOf(tenantId: string, version: number) {
  const last = version > 0 ? await prisma.activationEvent.findUnique({ where: { tenantId_version: { tenantId, version } }, select: { occurredAt: true } }) : null;
  return { version, updatedAt: last?.occurredAt.toISOString() ?? null };
}
