import type { FastifyInstance } from "fastify";
import { requireMerchant } from "../lib/auth.js";
import {
  createBusinessPublication,
  listMerchantBusinessPublications,
} from "../services/business-publications.js";

export async function registerBusinessPublicationRoutes(app: FastifyInstance) {
  app.get("/v1/publications", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return listMerchantBusinessPublications(auth.tenantId);
  });

  app.post("/v1/publications", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    try {
      const created = await createBusinessPublication(auth.tenantId, req.body);
      return reply.code(201).send(created);
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(e.statusCode ?? 400).send({
        error: e.code ?? "bad_request",
        message: e.message ?? "Could not create publication",
      });
    }
  });
}
