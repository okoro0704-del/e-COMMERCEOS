import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readBearer } from "../lib/auth.js";
import { operatorLogin, operatorLogout, requireOperator } from "../services/platform-auth.js";
import {
  createPartner,
  listActivations,
  listCommissions,
  listPartners,
  listStores,
  platformOverview,
  rejectActivation,
  reverseActivation,
  setPartnerStatus,
  verifyActivation,
} from "../services/activation.js";

/**
 * Digiconomy platform console: verify setup payments, manage marketing partners and see
 * commissions. Verifiers review submissions; only admins reverse and manage partners.
 */
export async function registerPlatformRoutes(app: FastifyInstance) {
  app.post("/v1/platform/login", async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(1024) }).parse(req.body);
    return operatorLogin(body);
  });

  app.post("/v1/platform/logout", async (req, reply) => {
    const token = readBearer(req);
    if (token) await operatorLogout(token);
    return reply.code(204).send();
  });

  app.get("/v1/platform/me", async (req, reply) => {
    const auth = await requireOperator(req, reply);
    if (!auth) return;
    return { operator: auth };
  });

  app.get("/v1/platform/overview", async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    return platformOverview();
  });

  app.get("/v1/platform/stores", async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    return listStores();
  });

  app.get("/v1/platform/activations", async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const query = z.object({ status: z.string().optional() }).parse(req.query);
    return listActivations(query);
  });

  app.post("/v1/platform/activations/:id/verify", async (req, reply) => {
    const auth = await requireOperator(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z
      .object({ amountReceivedMinor: z.number().int().nonnegative(), currency: z.string().length(3) })
      .parse(req.body);
    return verifyActivation(auth, id, body);
  });

  app.post("/v1/platform/activations/:id/reject", async (req, reply) => {
    const auth = await requireOperator(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return rejectActivation(auth, id, body.reason);
  });

  app.post("/v1/platform/activations/:id/reverse", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return reverseActivation(auth, id, body.reason);
  });

  app.get("/v1/platform/partners", async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    return listPartners();
  });

  app.post("/v1/platform/partners", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const body = z
      .object({ code: z.string().min(3).max(32), name: z.string().trim().min(1).max(120), email: z.string().email() })
      .parse(req.body);
    return reply.code(201).send(await createPartner(auth, body));
  });

  app.post("/v1/platform/partners/:id/:action", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id, action } = z.object({ id: z.string().min(1), action: z.enum(["suspend", "reactivate"]) }).parse(req.params);
    return setPartnerStatus(auth, id, action === "suspend" ? "suspended" : "active");
  });

  app.get("/v1/platform/commissions", async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const query = z.object({ partnerId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    return listCommissions(query);
  });
}
