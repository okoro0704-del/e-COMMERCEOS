import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { hashToken, httpError } from "./crypto.js";
import { getTrustIdProvider } from "../services/lifeos/container.js";
import type { TrustIdSessionProof } from "@lifeos/shared";

export type MerchantAuth = {
  kind: "merchant";
  sessionId: string;
  tenantId: string;
  staffId: string;
  displayName: string;
  role: string;
  email: string;
  trustId?: string | null;
};

export type BuyerAuth = {
  kind: "buyer";
  tenantId: string;
  trustId: string;
  sessionToken: string;
  verified: boolean;
};

export type AuthContext = MerchantAuth | BuyerAuth;

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    tenantId?: string;
    trustProof?: TrustIdSessionProof;
  }
}

function readBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export async function resolveTenantId(req: FastifyRequest): Promise<string | null> {
  const header = req.headers["x-tenant-id"];
  if (typeof header === "string" && header.trim()) return header.trim();

  const subdomain = req.headers["x-store-subdomain"];
  if (typeof subdomain === "string" && subdomain.trim()) {
    const store = await prisma.storeConfig.findUnique({ where: { subdomain: subdomain.trim().toLowerCase() } });
    return store?.tenantId ?? null;
  }

  return null;
}

export async function resolveMerchantAuth(req: FastifyRequest): Promise<MerchantAuth | null> {
  const token = readBearer(req);
  if (!token) return null;

  const session = await prisma.staffSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { staff: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.staff.status !== "active") return null;

  return {
    kind: "merchant",
    sessionId: session.id,
    tenantId: session.tenantId,
    staffId: session.staffId,
    displayName: session.staff.displayName,
    role: session.staff.role,
    email: session.staff.email,
    trustId: session.staff.trustId,
  };
}

export async function resolveBuyerAuth(req: FastifyRequest): Promise<BuyerAuth | null> {
  const token = readBearer(req);
  if (!token) return null;
  const proof = await getTrustIdProvider().resolveSession(token);
  if (!proof?.trustId) return null;
  req.trustProof = proof;
  const tenantId = await resolveTenantId(req);
  if (!tenantId) return null;
  return {
    kind: "buyer",
    tenantId,
    trustId: proof.trustId,
    sessionToken: token,
    verified: proof.verified !== false,
  };
}

export async function requireMerchant(req: FastifyRequest, reply: FastifyReply): Promise<MerchantAuth | void> {
  const auth = await resolveMerchantAuth(req);
  if (!auth) {
    reply.code(401).send({ error: "unauthorized", message: "Merchant session required" });
    return;
  }
  req.auth = auth;
  req.tenantId = auth.tenantId;
  return auth;
}

export async function requireBuyer(req: FastifyRequest, reply: FastifyReply): Promise<BuyerAuth | void> {
  const auth = await resolveBuyerAuth(req);
  if (!auth) {
    reply.code(401).send({ error: "unauthorized", message: "Trust ID session required" });
    return;
  }
  req.auth = auth;
  req.tenantId = auth.tenantId;
  return auth;
}

export async function requireTenant(req: FastifyRequest, reply: FastifyReply): Promise<string | void> {
  if (req.tenantId) return req.tenantId;
  const tenantId = await resolveTenantId(req);
  if (!tenantId) {
    reply.code(400).send({ error: "tenant_required", message: "x-tenant-id or x-store-subdomain is required" });
    return;
  }
  req.tenantId = tenantId;
  return tenantId;
}

export function assertTenant(authTenantId: string, resourceTenantId: string) {
  if (authTenantId !== resourceTenantId) {
    throw httpError(403, "forbidden", "Tenant mismatch");
  }
}
