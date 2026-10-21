import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { writeAudit } from "./audit.js";
import { jtiDigest, parseTrustedServices, ServiceTokenError, verifyServiceToken, type TrustedServices } from "./service-token.js";
import { requireInternalToken } from "../routes/internal/provision.js";

/** Permissions eCommerceOS grants to calling services (assigned per issuer in ECO_TRUSTED_SERVICES). */
export const SERVICE_PERMISSIONS = ["stores:provision", "stores:admin-handoff", "stores:read", "stores:bind-business"] as const;
export type ServicePermission = (typeof SERVICE_PERMISSIONS)[number];

let trustedCache: { raw: string; trusted: TrustedServices } | null = null;
function trustedServices(): TrustedServices {
  if (trustedCache?.raw !== config.trustedServicesJson) {
    trustedCache = { raw: config.trustedServicesJson, trusted: parseTrustedServices(config.trustedServicesJson) };
  }
  return trustedCache.trusted;
}

let consumed = 0;
/** Records a jti once; a repeat is a replay. Expired records are pruned now and then. */
async function consumeJti(iss: string, jti: string, expiresAt: Date) {
  try {
    await prisma.serviceTokenUse.create({ data: { digest: jtiDigest(iss, jti), issuer: iss, expiresAt } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false;
    throw new ServiceTokenError("service_replay_unavailable", 503);
  }
  if (++consumed % 100 === 0) {
    await prisma.serviceTokenUse.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  }
  return true;
}

function looksSigned(authorization: string | undefined) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return token.split(".").length === 3;
}

export type ServiceCaller = { kind: "signed"; issuer: string } | { kind: "shared" };

async function audit(req: FastifyRequest, permission: ServicePermission, outcome: string, issuer?: string) {
  await writeAudit({
    actorKind: "service",
    actorId: issuer ?? null,
    action: outcome === "authorized" ? "service.call_authorized" : "service.call_refused",
    resource: "internal_route",
    resourceId: `${req.method} ${req.url.split("?")[0]}`,
    metadata: { permission, outcome, correlationId: req.id },
  }).catch(() => undefined);
}

/**
 * Authorizes a call from another Digiconomy service. Sends the refusal and returns undefined when
 * the caller may not proceed.
 */
export async function authorizeService(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: ServicePermission,
): Promise<ServiceCaller | undefined> {
  const trusted = trustedServices();
  const signed = looksSigned(req.headers.authorization);
  if (signed && Object.keys(trusted).length) {
    try {
      const idk = req.headers["idempotency-key"];
      const caller = await verifyServiceToken({
        authorization: req.headers.authorization,
        idempotencyKey: typeof idk === "string" ? idk : undefined,
        method: req.method,
        path: req.url.split("?")[0]!,
        body: (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0),
        audience: config.serviceId,
        permission,
        trusted,
        production: config.env === "production",
        consumeJti,
      });
      await audit(req, permission, "authorized", caller.issuer);
      return { kind: "signed", issuer: caller.issuer };
    } catch (err) {
      const e = err instanceof ServiceTokenError ? err : new ServiceTokenError("token_malformed", 401);
      await audit(req, permission, e.code);
      reply.code(e.statusCode).send({ error: e.code, message: "Service credential refused", requestId: req.id });
      return undefined;
    }
  }
  if (config.serviceAuthMode === "signed") {
    const code = Object.keys(trusted).length ? "service_token_required" : "service_identity_unconfigured";
    await audit(req, permission, code);
    reply.code(code === "service_token_required" ? 401 : 503).send({ error: code, message: "A signed service credential is required", requestId: req.id });
    return undefined;
  }
  if (requireInternalToken(req.headers.authorization)) return { kind: "shared" };
  reply.code(401).send({ error: "unauthorized", message: "Valid service bearer token required" });
  return undefined;
}
