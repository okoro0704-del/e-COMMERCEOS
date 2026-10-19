import { prisma } from "../db.js";
import { httpError } from "../lib/crypto.js";
import { writeAudit } from "../lib/audit.js";
import { reverseActivation } from "./activation.js";
import type { OperatorAuth } from "./platform-auth.js";

/**
 * Two-person rule for high-risk platform actions. Reversing a verified activation reopens the
 * store's fee, closes the store and reverses the partner's commission, so one admin requests it
 * and a different admin approves it; only then does it run. One open request per activation.
 */
export const APPROVAL_KINDS = ["activation.reverse"] as const;

function isUnique(err: unknown) {
  return (err as { code?: string })?.code === "P2002";
}

function present(row: {
  id: string;
  kind: string;
  targetId: string;
  reason: string;
  status: string;
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.targetId,
    reason: row.reason,
    status: row.status,
    requestedById: row.requestedById,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function requestReversal(admin: OperatorAuth, activationId: string, reason: string) {
  const activation = await prisma.activation.findUnique({ where: { id: activationId } });
  if (!activation) throw httpError(404, "not_found", "Activation not found");
  if (activation.status !== "verified") throw httpError(409, "not_verified", `This activation is ${activation.status}.`);
  let row;
  try {
    row = await prisma.platformApproval.create({
      data: {
        kind: "activation.reverse",
        targetId: activationId,
        reason: reason.trim(),
        requestedById: admin.operatorId,
        pendingKey: `activation.reverse:${activationId}`,
      },
    });
  } catch (err) {
    if (isUnique(err)) throw httpError(409, "approval_pending", "A reversal of this activation is already awaiting approval.");
    throw err;
  }
  await writeAudit({
    tenantId: activation.tenantId,
    actorKind: "platform_operator",
    actorId: admin.operatorId,
    action: "platform.approval_requested",
    resource: "platform_approval",
    resourceId: row.id,
    metadata: { kind: row.kind, targetId: activationId, reason: row.reason },
  });
  return present(row);
}

export async function listApprovals(status?: string) {
  const rows = await prisma.platformApproval.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return { approvals: rows.map(present) };
}

/**
 * Approve (a different admin; the action then runs) or decline (any admin; the requester
 * declining their own request cancels it). The decision is a conditional write: one decision wins.
 */
export async function decideApproval(admin: OperatorAuth, id: string, decision: "approve" | "decline", note?: string) {
  const row = await prisma.platformApproval.findUnique({ where: { id } });
  if (!row) throw httpError(404, "not_found", "Approval request not found");
  if (decision === "approve" && row.requestedById === admin.operatorId) {
    throw httpError(403, "same_approver", "A different admin must approve this request.");
  }
  const status = decision === "approve" ? "approved" : row.requestedById === admin.operatorId ? "cancelled" : "declined";
  const claimed = await prisma.platformApproval.updateMany({
    where: { id, status: "pending", ...(decision === "approve" ? { requestedById: { not: admin.operatorId } } : {}) },
    data: { status, pendingKey: null, decidedById: admin.operatorId, decidedAt: new Date(), decisionNote: note?.trim() || null },
  });
  if (claimed.count !== 1) throw httpError(409, "not_pending", "This request was already decided.");

  let activation;
  if (decision === "approve") {
    try {
      activation = await reverseActivation(admin, row.targetId, row.reason, { approvalId: row.id, requestedById: row.requestedById });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "failed";
      await prisma.platformApproval.update({ where: { id }, data: { status: "failed", decisionNote: `could not run: ${code}` } });
      throw err;
    }
  }
  await writeAudit({
    actorKind: "platform_operator",
    actorId: admin.operatorId,
    action: `platform.approval_${status}`,
    resource: "platform_approval",
    resourceId: id,
    metadata: { kind: row.kind, targetId: row.targetId, requestedById: row.requestedById },
  });
  return { approval: present(await prisma.platformApproval.findUniqueOrThrow({ where: { id } })), ...(activation ? { activation } : {}) };
}
