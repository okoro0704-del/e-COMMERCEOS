import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readBearer } from "../lib/auth.js";
import {
  acceptInvitation,
  confirmMfaEnrollment,
  inviteOperator,
  listInvitations,
  listOperators,
  operatorLogin,
  operatorLogout,
  platformAuditLog,
  PLATFORM_ROLES,
  requireOperator,
  resetOperatorMfa,
  revokeInvitation,
  revokeOperatorSessions,
  setOperatorRole,
  setOperatorStatus,
  startMfaEnrollment,
  verifyMfaChallenge,
} from "../services/platform-auth.js";
import { decideApproval, listApprovals, requestReversal } from "../services/platform-approvals.js";
import {
  createPartner,
  listActivations,
  listCommissions,
  listPartners,
  listStores,
  platformOverview,
  rejectActivation,
  setPartnerStatus,
  verifyActivation,
} from "../services/activation.js";

/**
 * Digiconomy platform console: verify setup payments, manage marketing partners and see
 * commissions. Every session is MFA-verified. Verifiers review submissions; admins manage
 * partners and operators, and a reversal needs a second admin's approval.
 */
export async function registerPlatformRoutes(app: FastifyInstance) {
  const code = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");
  const pendingToken = z.string().min(10).max(200);

  // ---- Sign-in and two-step verification -----------------------------------------------------
  app.post("/v1/platform/login", async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(1024) }).parse(req.body);
    return operatorLogin(body);
  });

  app.post("/v1/platform/login/mfa", async (req) => {
    const body = z.object({ token: pendingToken, code }).parse(req.body);
    return verifyMfaChallenge(body.token, body.code);
  });

  app.post("/v1/platform/mfa/enroll/start", async (req) => {
    const body = z.object({ token: pendingToken }).parse(req.body);
    return startMfaEnrollment(body.token);
  });

  app.post("/v1/platform/mfa/enroll/confirm", async (req) => {
    const body = z.object({ token: pendingToken, code }).parse(req.body);
    return confirmMfaEnrollment(body.token, body.code);
  });

  app.post("/v1/platform/invitations/accept", async (req) => {
    const body = z
      .object({ code: z.string().min(10).max(200), displayName: z.string().trim().min(1).max(120), password: z.string().min(1).max(1024) })
      .parse(req.body);
    return acceptInvitation(body);
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

  app.post("/v1/platform/me/sign-out-everywhere", async (req, reply) => {
    const auth = await requireOperator(req, reply);
    if (!auth) return;
    return revokeOperatorSessions(auth, auth.operatorId);
  });

  // ---- Operators (admins) ------------------------------------------------------------------
  app.get("/v1/platform/operators", async (req, reply) => {
    if (!(await requireOperator(req, reply, { roles: ["admin"] }))) return;
    return listOperators();
  });

  app.post("/v1/platform/operators/invite", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const body = z.object({ email: z.string().email(), role: z.enum(PLATFORM_ROLES) }).parse(req.body);
    return reply.code(201).send(await inviteOperator(auth, body));
  });

  app.get("/v1/platform/invitations", async (req, reply) => {
    if (!(await requireOperator(req, reply, { roles: ["admin"] }))) return;
    return listInvitations();
  });

  app.post("/v1/platform/invitations/:id/revoke", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    await revokeInvitation(auth, id);
    return reply.code(204).send();
  });

  app.post("/v1/platform/operators/:id/role", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z.object({ role: z.enum(PLATFORM_ROLES) }).parse(req.body);
    return setOperatorRole(auth, id, body.role);
  });

  app.post("/v1/platform/operators/:id/:action", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id, action } = z
      .object({ id: z.string().min(1), action: z.enum(["suspend", "reactivate", "reset-mfa", "revoke-sessions"]) })
      .parse(req.params);
    if (action === "reset-mfa") {
      await resetOperatorMfa(auth, id);
      return reply.code(204).send();
    }
    if (action === "revoke-sessions") return revokeOperatorSessions(auth, id);
    return setOperatorStatus(auth, id, action === "suspend" ? "suspended" : "active");
  });

  app.get("/v1/platform/audit", async (req, reply) => {
    if (!(await requireOperator(req, reply, { roles: ["admin"] }))) return;
    const query = z.object({ limit: z.coerce.number().int().optional() }).parse(req.query);
    return platformAuditLog(query.limit);
  });

  // ---- Activations ---------------------------------------------------------------------------
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

  /** Requests a reversal; it runs only when a different admin approves it. */
  app.post("/v1/platform/activations/:id/reverse", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return reply.code(202).send({ approval: await requestReversal(auth, id, body.reason) });
  });

  app.get("/v1/platform/approvals", async (req, reply) => {
    if (!(await requireOperator(req, reply, { roles: ["admin"] }))) return;
    const query = z.object({ status: z.string().optional() }).parse(req.query);
    return listApprovals(query.status);
  });

  app.post("/v1/platform/approvals/:id/:decision", async (req, reply) => {
    const auth = await requireOperator(req, reply, { roles: ["admin"] });
    if (!auth) return;
    const { id, decision } = z.object({ id: z.string().min(1), decision: z.enum(["approve", "decline"]) }).parse(req.params);
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return decideApproval(auth, id, decision, body.note);
  });

  // ---- Partners and commissions --------------------------------------------------------------
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
