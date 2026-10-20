import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { provisionEcommerceTenant } from "../../services/distributor/provision-tenant.js";
import { storeOpenForBuyers } from "../../services/activation.js";
import { prisma } from "../../db.js";
import { authorizeService } from "../../lib/service-auth.js";
import { writeAudit } from "../../lib/audit.js";
import { activationVersionOf } from "../../services/activation-events.js";
import { businessIdOf, installIdOf } from "../../services/store-identity.js";

function bearerEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireInternalToken(authHeader: string | undefined): boolean {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return false;
  return bearerEquals(token, config.internalProvisionToken);
}

/**
 * LifeOS Portal / Master Distributor → ECommerceOS install handshake.
 * POST /internal/distributor/provision
 */
export async function registerInternalProvisionRoutes(app: FastifyInstance) {
  app.post("/internal/distributor/provision", async (req, reply) => {
    const caller = await authorizeService(req, reply, "stores:provision");
    if (!caller) return;
    if (config.provisioningPaused) {
      return reply.code(503).send({
        error: "provisioning_paused",
        message: "New stores cannot be created during maintenance. Nothing was created; retry the same request later.",
        requestId: req.id,
      });
    }

    const body = z
      .object({
        distributorTenantId: z.string().min(1).optional(),
        tenantId: z.string().min(1).optional(),
        /** LifeOS Portal install id; when absent, tenantId is taken as the install id. */
        installId: z.string().min(1).max(128).optional(),
        subdomain: z.string().min(1).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i),
        slug: z.string().min(1).optional(),
        displayName: z.string().min(1),
        customDomain: z.string().optional(),
        brand: z
          .object({
            primaryColor: z.string().optional(),
            logoUrl: z.string().url().optional(),
          })
          .optional(),
        oauthDestinations: z.array(z.string()).optional(),
        modules: z.array(z.string()).optional(),
        seed: z.enum(["default", "none"]).optional(),
        trustId: z
          .object({
            audience: z.string().optional(),
            businessPublicId: z.string().optional(),
          })
          .optional(),
        /** The LifeOS business (minted by Portal, immutable). trustId.businessPublicId is its older alias. */
        businessId: z.string().min(1).max(128).optional(),
        adminStaff: z
          .object({
            email: z.string().email(),
            displayName: z.string().min(1),
            role: z.string().optional(),
            password: z.string().min(8).max(1024).optional(),
            temporaryPassword: z.boolean().optional(),
          })
          .optional(),
        owner: z.object({ subject: z.string().min(3).max(200) }).optional(),
        organization: z
          .object({
            slug: z.string().optional(),
            name: z.string().optional(),
          })
          .optional(),
        manifestVersion: z.string().optional(),
        pickup: z
          .object({
            addressLine1: z.string().optional(),
            city: z.string().optional(),
            region: z.string().optional(),
            postalCode: z.string().optional(),
            country: z.string().optional(),
            lat: z.number().optional(),
            lng: z.number().optional(),
          })
          .optional(),
        defaultCurrency: z.string().optional(),
        deliveryRadiusKm: z.number().optional(),
        walletPayoutAccount: z.string().optional(),
        verticalId: z.string().optional(),
        hasPhysicalAddress: z.boolean().optional(),
      })
      .refine((v) => Boolean(v.distributorTenantId ?? v.tenantId), {
        message: "distributorTenantId or tenantId is required",
      })
      .parse(req.body);

    // Another service may not set an owner's password or where money is paid: the owner sets their
    // password through the handoff, and payout details come only from the owner. Legacy shared-token
    // callers keep the old behaviour until that token is retired.
    if (caller.kind === "signed") {
      const fields = [body.adminStaff?.password !== undefined && "adminStaff.password", body.walletPayoutAccount !== undefined && "walletPayoutAccount"].filter(Boolean);
      if (fields.length) {
        return reply.code(400).send({ error: "field_not_allowed", message: "A service call may not set an owner password or a payout account.", fields, requestId: req.id });
      }
    }

    if (body.businessId && body.trustId?.businessPublicId && body.businessId !== body.trustId.businessPublicId) {
      return reply.code(400).send({ error: "business_id_mismatch", message: "businessId and trustId.businessPublicId must name the same business.", requestId: req.id });
    }

    // Idempotency-Key names the install: "portal-install:<installId, else tenantId>".
    const header = req.headers["idempotency-key"];
    const idempotencyKey = typeof header === "string" ? header : undefined;
    const installRef = body.installId ?? body.tenantId ?? body.distributorTenantId;
    if (idempotencyKey !== undefined && idempotencyKey !== `portal-install:${installRef}`) {
      return reply.code(400).send({ error: "idempotency_key_mismatch", message: "Idempotency-Key must be portal-install:<install id>" });
    }
    const requestHash = createHash("sha256").update(canonicalJson(body)).digest("hex");

    try {
      const result = await provisionEcommerceTenant({
        installId: body.installId ?? (idempotencyKey ? installRef : undefined),
        idempotencyKey,
        requestHash,
        distributorTenantId: body.distributorTenantId ?? body.tenantId!,
        tenantId: body.tenantId,
        subdomain: body.subdomain,
        slug: body.slug,
        displayName: body.displayName,
        customDomain: body.customDomain,
        brand: body.brand,
        oauthDestinations: body.oauthDestinations,
        modules: body.modules,
        seed: body.seed,
        trustId: body.trustId,
        businessId: body.businessId ?? body.trustId?.businessPublicId,
        adminStaff: body.adminStaff,
        owner: body.owner,
        organization: body.organization,
        manifestVersion: body.manifestVersion,
        pickup: body.pickup,
        defaultCurrency: body.defaultCurrency,
        deliveryRadiusKm: body.deliveryRadiusKm,
        walletPayoutAccount: body.walletPayoutAccount,
        verticalId: body.verticalId,
        hasPhysicalAddress: body.hasPhysicalAddress,
      });
      return reply.code("replayed" in result ? 200 : 201).send(result);
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      // A deliberate 503 (the same install is still being set up) passes through as retryable.
      if (!e.statusCode || (e.statusCode >= 500 && e.statusCode !== 503)) {
        // Internal details stay in the log; nothing of a failed attempt is kept, so a retry is safe.
        req.log.error({ err }, "provisioning failed");
        return reply.code(500).send({
          error: "provision_failed",
          message: "Provisioning failed and nothing was kept. Retry the same request.",
          requestId: req.id,
        });
      }
      return reply.code(e.statusCode).send({ error: e.code ?? "provision_failed", message: e.message ?? "Provision failed" });
    }
  });

  /** Provisioning and activation status of one store, for LifeOS Portal to poll. */
  app.get("/internal/ecommerceos/stores/:subdomain", async (req, reply) => {
    if (!(await authorizeService(req, reply, "stores:read"))) return;
    const { subdomain } = z.object({ subdomain: z.string().min(1).max(100) }).parse(req.params);
    const tenant = await prisma.tenant.findUnique({
      where: { slug: subdomain.trim().toLowerCase() },
      include: { storeConfig: true, staff: { where: { role: "owner", status: "active" } }, portalInstall: true },
    });
    // provisioningPaused true: this process creates no stores, so a 404 cannot be overtaken by a request in flight.
    if (!tenant) return reply.code(404).send({ error: "not_found", message: "Store not found", provisioningPaused: config.provisioningPaused });
    return {
      tenantId: tenant.id,
      subdomain: tenant.slug,
      status: tenant.status,
      provisioned: Boolean(tenant.storeConfig),
      ownerBound: tenant.staff.some((s) => Boolean(s.trustId)),
      // Bindings Portal checks against its own record.
      installId: installIdOf(tenant),
      businessId: businessIdOf(tenant),
      ownerSubject: tenant.staff.find((s) => s.trustId)?.trustId ?? null,
      activation: {
        required: config.activationRequired,
        status: tenant.activationStatus,
        storeOpen: await storeOpenForBuyers(tenant.id),
        // Portal compares this with the last event it applied; a lower version means one is missing.
        ...(await activationVersionOf(tenant.id, tenant.activationVersion)),
      },
      createdAt: tenant.createdAt.toISOString(),
      provisioningPaused: config.provisioningPaused,
    };
  });

  /**
   * Binds the stable LifeOS business id to a store that has none yet (created before it existed), once.
   * The same id again is a no-op; a store already bound to a different business is never changed.
   */
  app.post("/internal/ecommerceos/stores/:subdomain/business", async (req, reply) => {
    const caller = await authorizeService(req, reply, "stores:bind-business");
    if (!caller) return;
    const { subdomain } = z.object({ subdomain: z.string().min(1).max(100) }).parse(req.params);
    const body = z
      .object({ businessId: z.string().min(1).max(128), installId: z.string().min(1).max(128), ownerSubject: z.string().min(3).max(200) })
      .parse(req.body);
    const tenant = await prisma.tenant.findUnique({
      where: { slug: subdomain.trim().toLowerCase() },
      include: { portalInstall: true, staff: { where: { role: "owner", status: "active" } } },
    });
    if (!tenant) return reply.code(404).send({ error: "not_found", message: "Store not found" });
    if (installIdOf(tenant) !== body.installId) return reply.code(403).send({ error: "install_mismatch", message: "This store belongs to another install." });
    if (!tenant.staff.some((s) => s.trustId === body.ownerSubject)) return reply.code(403).send({ error: "owner_mismatch", message: "This store belongs to another owner." });
    const current = businessIdOf(tenant);
    if (current === body.businessId) return { ok: true, replayed: true, tenantId: tenant.id, businessId: current };
    if (current !== null) return reply.code(409).send({ error: "business_id_conflict", message: "This store is already bound to a different business." });
    // Conditional on the value just read, so two concurrent binds cannot both win.
    const bound = await prisma.tenant.updateMany({ where: { id: tenant.id, lifeosBusinessId: tenant.lifeosBusinessId }, data: { lifeosBusinessId: body.businessId } });
    if (bound.count !== 1) return reply.code(409).send({ error: "business_id_conflict", message: "The store's business changed meanwhile; read its status and retry." });
    await writeAudit({
      tenantId: tenant.id,
      actorKind: "service",
      actorId: caller.kind === "signed" ? caller.issuer : null,
      action: "portal.business_bound",
      resource: "tenant",
      resourceId: tenant.id,
      metadata: { businessId: body.businessId, installId: body.installId, replacedInstallCopy: tenant.lifeosBusinessId !== null },
    });
    return { ok: true, bound: true, tenantId: tenant.id, businessId: body.businessId };
  });
}


/** JSON with sorted keys, so the same request always has the same fingerprint. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
