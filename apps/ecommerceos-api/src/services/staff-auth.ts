import { prisma } from "../db.js";
import { config } from "../config.js";
import { generateSessionToken, hashToken, httpError, verifyPassword } from "../lib/crypto.js";

export async function merchantLogin(opts: { email: string; password: string; tenantSlug?: string }) {
  const staff = await prisma.staffMember.findFirst({
    where: {
      email: opts.email,
      status: "active",
      ...(opts.tenantSlug ? { tenant: { slug: opts.tenantSlug } } : {}),
    },
    include: { tenant: true },
  });
  if (!staff || !verifyPassword(opts.password, staff.passwordHash)) {
    throw httpError(401, "unauthorized", "Invalid credentials");
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.staffSessionTtlHours * 60 * 60 * 1000);
  await prisma.staffSession.create({
    data: {
      tenantId: staff.tenantId,
      staffId: staff.id,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    staff: {
      id: staff.id,
      displayName: staff.displayName,
      email: staff.email,
      role: staff.role,
      tenantId: staff.tenantId,
      tenantSlug: staff.tenant.slug,
    },
  };
}

export async function merchantLogout(token: string) {
  await prisma.staffSession.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { revokedAt: new Date() },
  });
}
