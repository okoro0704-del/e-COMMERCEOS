import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";

export async function writeAudit(opts: {
  tenantId?: string | null;
  actorKind: string;
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: opts.tenantId ?? null,
      actorKind: opts.actorKind,
      actorId: opts.actorId ?? null,
      action: opts.action,
      resource: opts.resource,
      resourceId: opts.resourceId ?? null,
      metadata: (opts.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
