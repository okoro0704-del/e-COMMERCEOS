import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireMerchant, STORE_ADMIN_ROLES } from "../lib/auth.js";
import { httpError } from "../lib/crypto.js";
import { writeAudit } from "../lib/audit.js";

function settingsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function readBranding(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { storeConfig: true } });
  if (!tenant?.storeConfig) throw httpError(404, "not_found", "Store not found");
  const settings = settingsOf(tenant.settings);
  return {
    storeName: tenant.storeConfig.storeName,
    tagline: typeof settings.tagline === "string" ? settings.tagline : "",
    primaryColor: tenant.primaryColor,
    logoUrl: tenant.logoUrl,
    logoAssetId: typeof settings.logoAssetId === "string" ? settings.logoAssetId : null,
  };
}

/** Merchant branding for the store's own storefront: name, tagline, colour and logo. */
export async function registerStoreSettingsRoutes(app: FastifyInstance) {
  app.get("/v1/store/branding", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return readBranding(auth.tenantId);
  });

  app.patch("/v1/store/branding", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    const body = z
      .object({
        storeName: z.string().trim().min(1).max(80).optional(),
        tagline: z.string().trim().max(160).optional(),
        primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a colour like #1D4ED8").optional(),
        logoAssetId: z.string().min(1).nullable().optional(),
      })
      .parse(req.body);
    if (body.logoAssetId) {
      const asset = await prisma.mediaAsset.findFirst({ where: { id: body.logoAssetId, tenantId: auth.tenantId } });
      if (!asset || !(asset.contentType ?? "").startsWith("image/")) {
        throw httpError(400, "invalid_logo", "Upload an image to this store first.");
      }
    }
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
    const settings = settingsOf(tenant.settings);
    if (body.tagline !== undefined) settings.tagline = body.tagline;
    if (body.logoAssetId !== undefined) settings.logoAssetId = body.logoAssetId;
    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: auth.tenantId },
        data: {
          ...(body.storeName ? { name: body.storeName } : {}),
          ...(body.primaryColor ? { primaryColor: body.primaryColor.toUpperCase() } : {}),
          settings: settings as Prisma.InputJsonValue,
        },
      }),
      ...(body.storeName
        ? [prisma.storeConfig.update({ where: { tenantId: auth.tenantId }, data: { storeName: body.storeName } })]
        : []),
    ]);
    await writeAudit({
      tenantId: auth.tenantId,
      actorKind: "merchant",
      actorId: auth.staffId,
      action: "store.branding_updated",
      resource: "store",
      resourceId: auth.tenantId,
      metadata: { fields: Object.keys(body) },
    });
    return readBranding(auth.tenantId);
  });
}
