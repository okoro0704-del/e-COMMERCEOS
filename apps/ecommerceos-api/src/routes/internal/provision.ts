import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { provisionEcommerceTenant } from "../../services/distributor/provision-tenant.js";

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
    if (!requireInternalToken(req.headers.authorization)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Valid service bearer token required",
      });
    }

    const body = z
      .object({
        distributorTenantId: z.string().min(1).optional(),
        tenantId: z.string().min(1).optional(),
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
        adminStaff: z
          .object({
            email: z.string().email(),
            displayName: z.string().min(1),
            role: z.string().optional(),
            password: z.string().min(8).optional(),
          })
          .optional(),
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
      })
      .refine((v) => Boolean(v.distributorTenantId ?? v.tenantId), {
        message: "distributorTenantId or tenantId is required",
      })
      .parse(req.body);

    try {
      const result = await provisionEcommerceTenant({
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
        adminStaff: body.adminStaff,
        organization: body.organization,
        manifestVersion: body.manifestVersion,
        pickup: body.pickup,
        defaultCurrency: body.defaultCurrency,
        deliveryRadiusKm: body.deliveryRadiusKm,
        walletPayoutAccount: body.walletPayoutAccount,
      });
      return reply.code(201).send(result);
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(e.statusCode ?? 500).send({
        error: e.code ?? "provision_failed",
        message: e.message ?? "Provision failed",
      });
    }
  });
}
