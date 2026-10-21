import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { authorizeService } from "../../lib/service-auth.js";
import { createAdminHandoff } from "../../services/staff-auth.js";

/**
 * LifeOS Portal → EcommerceOS: a signed-in Portal owner opens their store admin.
 * POST /internal/ecommerceos/admin-handoff
 * Portal must have checked that the Portal user owns this install before calling.
 */
export async function registerAdminHandoffRoutes(app: FastifyInstance) {
  app.post("/internal/ecommerceos/admin-handoff", async (req, reply) => {
    if (!(await authorizeService(req, reply, "stores:admin-handoff"))) return;
    const body = z
      .object({
        subdomain: z.string().min(1).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i),
        tenantId: z.string().min(1).optional(),
        ownerSubject: z.string().min(3).max(200),
        ownerEmail: z.string().email().optional(),
        /** LifeOS Portal install id; must be the install this store was created for. */
        installId: z.string().min(1).max(128).optional(),
      })
      .parse(req.body);
    const handoff = await createAdminHandoff(body);
    const adminUrl = config.adminLaunchUrlTemplate.replaceAll("{subdomain}", body.subdomain.toLowerCase());
    // The code travels in the URL fragment so it never reaches server logs or Referer headers.
    return reply.code(201).send({
      ok: true,
      expiresInSec: handoff.expiresInSec,
      url: `${adminUrl}#handoff=${encodeURIComponent(handoff.code)}`,
    });
  });
}
