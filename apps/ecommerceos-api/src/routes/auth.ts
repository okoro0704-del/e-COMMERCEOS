import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  changeStaffPassword,
  exchangeAdminHandoff,
  merchantLogin,
  merchantLogout,
} from "../services/staff-auth.js";
import { readBearer, requireMerchant } from "../lib/auth.js";
import { createFailureThrottle } from "../lib/login-throttle.js";
import { httpError } from "../lib/crypto.js";

/** Per-client ceiling on failed credential attempts (per-account limits live in staff-auth). */
export const credentialIpThrottle = createFailureThrottle({ limit: 30, windowMs: 15 * 60 * 1000 });

function storeHandle(req: FastifyRequest, fromBody?: string) {
  const header = req.headers["x-store-subdomain"];
  const value = fromBody ?? (typeof header === "string" ? header : undefined);
  return value?.trim().toLowerCase() || null;
}

async function withIpThrottle<T>(req: FastifyRequest, work: () => Promise<T>): Promise<T> {
  if (credentialIpThrottle.blocked(req.ip)) {
    throw httpError(429, "too_many_attempts", "Too many failed attempts. Try again in 15 minutes.");
  }
  try {
    return await work();
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 400 || status === 401) credentialIpThrottle.fail(req.ip);
    throw err;
  }
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/v1/auth/merchant/login", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(1024),
        tenantSlug: z.string().min(1).optional(),
      })
      .parse(req.body);
    const tenantSlug = storeHandle(req, body.tenantSlug);
    if (!tenantSlug) {
      return reply.code(400).send({ error: "store_required", message: "Sign in from your store's admin address." });
    }
    const result = await withIpThrottle(req, () =>
      merchantLogin({ email: body.email, password: body.password, tenantSlug }),
    );
    return reply.send(result);
  });

  app.post("/v1/auth/merchant/handoff/exchange", async (req, reply) => {
    const body = z.object({ code: z.string().min(16).max(256) }).parse(req.body);
    const result = await withIpThrottle(req, () => exchangeAdminHandoff(body.code));
    return reply.send(result);
  });

  app.post("/v1/auth/merchant/logout", async (req, reply) => {
    const token = readBearer(req);
    if (token) await merchantLogout(token);
    return reply.send({ ok: true });
  });

  app.post("/v1/auth/merchant/password", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { allowPendingPasswordChange: true });
    if (!auth) return;
    const body = z
      .object({
        newPassword: z.string().min(1).max(1024),
        currentPassword: z.string().min(1).max(1024).optional(),
        resetGrant: z.string().min(16).max(256).optional(),
      })
      .parse(req.body);
    return reply.send(
      await changeStaffPassword({
        staffId: auth.staffId,
        sessionId: auth.sessionId,
        newPassword: body.newPassword,
        currentPassword: body.currentPassword,
        resetGrant: body.resetGrant,
      }),
    );
  });

  app.get("/v1/auth/merchant/me", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { allowPendingPasswordChange: true });
    if (!auth) return;
    return reply.send({ staff: auth });
  });
}
