import { prisma } from "../db.js";
import { config } from "../config.js";
import { loadSigningKey, signServiceToken } from "../lib/service-token.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Registers marketplace-created seller stores with LifeOS Portal (POST /internal/ecommerceos/
 * seller-install), signed with eCommerceOS's own service key and Idempotency-Key
 * "eco-seller:<applicationId>". The exact body is stored once, so a retry or a backfill sends the
 * identical bytes Portal recognises as a replay; every outcome is recorded, never assumed.
 */
const SELLER_INSTALL_PATH = "/internal/ecommerceos/seller-install";

export type SellerRegistrationInput = {
  applicationId: string;
  tenantId: string;
  subdomain: string;
  displayName: string;
  marketplaceSubdomain: string;
  marketplaceTenantId: string;
  organizationId?: string;
};

type Outcome = "registered" | "failed" | "conflict" | "pending";

function bodyOf(input: SellerRegistrationInput) {
  return JSON.stringify({
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    subdomain: input.subdomain,
    displayName: input.displayName,
    marketplaceSubdomain: input.marketplaceSubdomain,
    marketplaceTenantId: input.marketplaceTenantId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  });
}

export async function registerSellerWithPortal(input: SellerRegistrationInput): Promise<Outcome> {
  await prisma.portalSellerRegistration.upsert({
    where: { applicationId: input.applicationId },
    create: {
      applicationId: input.applicationId,
      sellerTenantId: input.tenantId,
      marketplaceTenantId: input.marketplaceTenantId,
      body: bodyOf(input),
    },
    update: {},
  });
  return sendRegistration(input.applicationId);
}

async function record(applicationId: string, status: Outcome, detail: { httpStatus?: number; error?: string; attempted: boolean }) {
  await prisma.portalSellerRegistration.update({
    where: { applicationId },
    data: {
      status,
      httpStatus: detail.httpStatus ?? null,
      lastError: detail.error ?? null,
      ...(detail.attempted ? { attempts: { increment: 1 }, lastAttemptAt: new Date() } : {}),
      ...(status === "registered" ? { registeredAt: new Date() } : {}),
    },
  });
  await writeAudit({
    tenantId: null,
    actorKind: "system",
    action: "portal.seller_registration",
    resource: "portal_seller_registration",
    resourceId: applicationId,
    metadata: { outcome: status, httpStatus: detail.httpStatus ?? null, error: detail.error ?? null },
  });
  return status;
}

/**
 * The Authorization header for a call to Portal: a token signed with eCommerceOS's key, bound to this
 * path, body and Idempotency-Key. Only seller registration, which predates the signed contract, may
 * fall back to the shared token in shared mode; every newer call is signed or not sent.
 */
export function portalAuthorization(path: string, body: string, idempotencyKey: string, opts: { sharedFallback?: boolean } = {}): string | null {
  const key = config.serviceSigningKey ? loadSigningKey(config.serviceSigningKey) : null;
  if (key && config.serviceSigningKid) {
    const token = signServiceToken({
      issuer: config.serviceId,
      kid: config.serviceSigningKid,
      key,
      audience: config.portalServiceId,
      method: "POST",
      path,
      body,
      idempotencyKey,
    });
    return `Bearer ${token}`;
  }
  // Before the joint release the shared token is still how Portal accepts a seller registration.
  return opts.sharedFallback && config.serviceAuthMode === "shared" ? `Bearer ${config.portalInternalToken}` : null;
}

/** Sends (or re-sends) one stored registration. A registered or conflicting one is left alone. */
async function sendRegistration(applicationId: string): Promise<Outcome> {
  const row = await prisma.portalSellerRegistration.findUnique({ where: { applicationId } });
  if (!row) return "failed";
  if (row.status === "registered" || row.status === "conflict") return row.status as Outcome;
  if (!config.portalApiUrl) return record(applicationId, "pending", { error: "portal_api_unconfigured", attempted: false });
  const target = new URL(`${config.portalApiUrl}${SELLER_INSTALL_PATH}`);
  const idempotencyKey = `eco-seller:${applicationId}`;
  const authorization = portalAuthorization(target.pathname, row.body, idempotencyKey, { sharedFallback: true });
  if (!authorization) return record(applicationId, "failed", { error: "signing_unconfigured", attempted: false });
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", accept: "application/json", "idempotency-key": idempotencyKey },
      body: row.body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 200 || res.status === 201) return record(applicationId, "registered", { httpStatus: res.status, attempted: true });
    // A 409 means Portal holds a different record: an operator reconciles it; retrying won't help.
    const status = res.status === 409 ? "conflict" : "failed";
    return record(applicationId, status, { httpStatus: res.status, error: payload.error ?? `http_${res.status}`, attempted: true });
  } catch (err) {
    const timeout = (err as { name?: string }).name === "TimeoutError";
    return record(applicationId, "failed", { error: timeout ? "portal_timeout" : "portal_unreachable", attempted: true });
  }
}

type SellerMembership = {
  sellerTenantId?: string | null;
  sellerApplicationId?: string | null;
  sellerSubdomain?: string | null;
  displayName?: string;
  createdByMarketplace?: boolean;
};

/** Sellers created before registrations were recorded get a row from the marketplace's list. */
async function discoverUnrecordedSellers() {
  const marketplaces = await prisma.tenant.findMany({ select: { id: true, slug: true, organizationId: true, settings: true } });
  let added = 0;
  for (const m of marketplaces) {
    const settings = m.settings && typeof m.settings === "object" ? (m.settings as { marketplaceSellers?: SellerMembership[] }) : {};
    for (const s of settings.marketplaceSellers ?? []) {
      if (!s.createdByMarketplace || !s.sellerTenantId || !s.sellerApplicationId || !s.sellerSubdomain) continue;
      const exists = await prisma.portalSellerRegistration.findUnique({ where: { applicationId: s.sellerApplicationId } });
      if (exists) continue;
      await prisma.portalSellerRegistration.create({
        data: {
          applicationId: s.sellerApplicationId,
          sellerTenantId: s.sellerTenantId,
          marketplaceTenantId: m.id,
          body: bodyOf({
            applicationId: s.sellerApplicationId,
            tenantId: s.sellerTenantId,
            subdomain: s.sellerSubdomain,
            displayName: s.displayName ?? s.sellerSubdomain,
            marketplaceSubdomain: m.slug,
            marketplaceTenantId: m.id,
            organizationId: m.organizationId ?? undefined,
          }),
        },
      });
      added += 1;
    }
  }
  return added;
}

/** Re-sends every unregistered seller; Portal's idempotency keeps it to one record each. */
export async function backfillSellerRegistrations(operatorId: string) {
  const discovered = await discoverUnrecordedSellers();
  const due = await prisma.portalSellerRegistration.findMany({ where: { status: { in: ["pending", "failed"] } }, orderBy: { createdAt: "asc" } });
  const outcomes: Record<string, number> = { registered: 0, failed: 0, conflict: 0, pending: 0 };
  for (const row of due) outcomes[await sendRegistration(row.applicationId)] += 1;
  const summary = { discovered, attempted: due.length, ...outcomes };
  await writeAudit({
    actorKind: "platform_operator",
    actorId: operatorId,
    action: "platform.seller_registration_backfill",
    resource: "portal_seller_registration",
    metadata: summary,
  });
  return summary;
}

export async function listSellerRegistrations() {
  const rows = await prisma.portalSellerRegistration.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  return {
    registrations: rows.map((r) => ({
      applicationId: r.applicationId,
      sellerTenantId: r.sellerTenantId,
      marketplaceTenantId: r.marketplaceTenantId,
      status: r.status,
      httpStatus: r.httpStatus,
      attempts: r.attempts,
      lastError: r.lastError,
      lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
      registeredAt: r.registeredAt?.toISOString() ?? null,
    })),
  };
}
