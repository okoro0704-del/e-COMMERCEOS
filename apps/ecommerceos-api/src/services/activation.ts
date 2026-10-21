import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { httpError } from "../lib/crypto.js";
import { writeAudit } from "../lib/audit.js";
import type { OperatorAuth } from "./platform-auth.js";
import { changeActivationStatus, sendActivationEventsInBackground } from "./activation-events.js";

/**
 * Commercial model: each business pays a one-time brand setup fee for its own independent
 * storefront. Payment happens outside the platform (manual transfer); Digiconomy platform staff
 * verify it by hand. A marketing partner who referred the business earns a commission on the
 * verified setup payment only, never on the store's customer orders.
 */
export const STANDARD_SETUP_FEE = { amountMinor: 3_000_000, currency: "NGN" } as const; // ₦30,000.00
export const PARTNER_COMMISSION_BPS = 500; // 5%

export type ActivationPlan = "standard" | "early_adopter";

type Offer = { plan: ActivationPlan; amountMinor: number; currency: string; available: boolean; reason?: string };

async function earlyAdopterOffer(): Promise<Offer> {
  const o = config.earlyAdopter;
  const offer = { plan: "early_adopter" as const, amountMinor: o.amountMinor, currency: o.currency };
  if (!o.enabled) return { ...offer, available: false, reason: "not_enabled" };
  if (!Number.isInteger(o.amountMinor) || o.amountMinor <= 0 || !/^[A-Z]{3}$/.test(o.currency)) {
    return { ...offer, available: false, reason: "misconfigured" };
  }
  if (o.until && !(Date.now() <= Date.parse(o.until))) return { ...offer, available: false, reason: "offer_ended" };
  if (o.limit > 0) {
    const used = await prisma.activation.count({ where: { plan: "early_adopter", status: "verified" } });
    if (used >= o.limit) return { ...offer, available: false, reason: "offer_full" };
  }
  return { ...offer, available: true };
}

export async function activationOffers(): Promise<Offer[]> {
  return [{ plan: "standard", ...STANDARD_SETUP_FEE, available: true }, await earlyAdopterOffer()];
}

export function commissionFor(amountMinor: number) {
  return Math.floor((amountMinor * PARTNER_COMMISSION_BPS) / 10_000);
}

/** Buyers can reach a store unless paid activation is required and it is still awaiting it. */
export async function storeOpenForBuyers(tenantId: string) {
  if (!config.activationRequired) return true;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { activationStatus: true } });
  return tenant?.activationStatus !== "pending";
}

export async function assertStoreOpen(tenantId: string) {
  if (!(await storeOpenForBuyers(tenantId))) {
    throw httpError(403, "store_not_active", "This store is not open yet.");
  }
}

/** Prisma filter for tenants whose catalogue may appear in cross-store public listings. */
export function buyerVisibleTenantWhere() {
  return config.activationRequired ? { activationStatus: { not: "pending" } } : {};
}

/** The status a newly provisioned store starts in. */
export function initialActivationStatus() {
  return config.activationRequired ? "pending" : "legacy";
}

function isUniqueViolation(err: unknown, field: string) {
  const e = err as { code?: string; meta?: { target?: unknown } };
  return e?.code === "P2002" && JSON.stringify(e.meta?.target ?? "").includes(field);
}

function normalizeReference(reference: string) {
  return reference.trim().toUpperCase().replace(/\s+/g, "");
}

type DocumentRow = {
  kind: string;
  number: string;
  status: string;
  billedToName: string;
  amountMinor: number;
  currency: string;
  transactionReference: string | null;
  taxTreatment: string;
  taxRateBps: number | null;
  taxAmountMinor: number | null;
  supplierTaxId: string | null;
  customerTaxId: string | null;
  issuedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
};

/**
 * Draft invoice and receipt fields for the setup fee. Tax treatment stays "unreviewed" with empty
 * rate and amount until Digiconomy decides how VAT applies; these are not final tax documents.
 */
export function presentDocument(d: DocumentRow) {
  return {
    kind: d.kind,
    number: d.number,
    status: d.status,
    draft: true,
    billedTo: d.billedToName,
    amountMinor: d.amountMinor,
    currency: d.currency,
    transactionReference: d.transactionReference,
    tax: {
      treatment: d.taxTreatment,
      rateBps: d.taxRateBps,
      amountMinor: d.taxAmountMinor,
      supplierTaxId: d.supplierTaxId,
      customerTaxId: d.customerTaxId,
    },
    issuedAt: d.issuedAt.toISOString(),
    voidedAt: d.voidedAt?.toISOString() ?? null,
    voidReason: d.voidReason,
  };
}

function documentNumber(kind: "invoice" | "receipt") {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${kind === "invoice" ? "DGC-INV" : "DGC-RCT"}-${day}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

type ActivationRow = Awaited<ReturnType<typeof prisma.activation.findFirstOrThrow>> & {
  documents?: DocumentRow[];
  partner?: { code: string; name: string } | null;
  commission?: { amountMinor: number; currency: string; status: string; rateBps: number } | null;
  tenant?: { slug: string; name: string; activationStatus: string } | null;
};

export function presentActivation(row: ActivationRow) {
  return {
    id: row.id,
    plan: row.plan,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    paymentReference: row.paymentReference,
    payerName: row.payerName,
    paidAt: row.paidAt?.toISOString() ?? null,
    submittedAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedReason: row.rejectedReason,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    reversedReason: row.reversedReason,
    partner: row.partner ? { code: row.partner.code, name: row.partner.name } : null,
    commission: row.commission
      ? {
          amountMinor: row.commission.amountMinor,
          currency: row.commission.currency,
          rateBps: row.commission.rateBps,
          status: row.commission.status,
          // No payout process exists yet; commissions are records only.
          payoutStatus: "disabled",
        }
      : null,
    documents: (row.documents ?? []).map(presentDocument),
    ...(row.tenant ? { store: { tenantId: row.tenantId, slug: row.tenant.slug, name: row.tenant.name } } : {}),
  };
}

// ---- Store owner ---------------------------------------------------------------------------

export async function getStoreActivation(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw httpError(404, "not_found", "Store not found");
  const submissions = await prisma.activation.findMany({
    where: { tenantId },
    include: { partner: true, commission: true, documents: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return {
    required: config.activationRequired,
    status: tenant.activationStatus,
    storeOpen: await storeOpenForBuyers(tenantId),
    offers: await activationOffers(),
    paymentInstructions: config.setupPaymentInstructions,
    // The commission is the partner's business; an owner sees who referred them, not the amount.
    submissions: submissions.map((row) => ({ ...presentActivation(row), commission: null })),
  };
}

export async function submitActivation(opts: {
  tenantId: string;
  staffId: string;
  plan: ActivationPlan;
  paymentReference: string;
  payerName: string;
  paidAt?: string;
  partnerCode?: string;
}) {
  const tenant = await prisma.tenant.findUnique({ where: { id: opts.tenantId } });
  if (!tenant) throw httpError(404, "not_found", "Store not found");
  if (tenant.activationStatus === "active") {
    throw httpError(409, "already_active", "This store's setup payment has already been verified.");
  }

  const offer = (await activationOffers()).find((o) => o.plan === opts.plan);
  if (!offer?.available) throw httpError(400, "offer_unavailable", "This setup price is not available.");

  let partnerId: string | null = null;
  if (opts.partnerCode?.trim()) {
    const partner = await prisma.marketingPartner.findUnique({ where: { code: opts.partnerCode.trim().toUpperCase() } });
    if (!partner || partner.status !== "active") {
      throw httpError(400, "invalid_partner_code", "That referral code is not valid.");
    }
    partnerId = partner.id;
  }

  const reference = normalizeReference(opts.paymentReference);
  if (reference.length < 4) throw httpError(400, "invalid_reference", "Enter the payment reference from your transfer.");
  let row;
  try {
    row = await prisma.activation.create({
      data: {
        tenantId: tenant.id,
        plan: offer.plan,
        amountMinor: offer.amountMinor,
        currency: offer.currency,
        status: "payment_submitted",
        partnerId,
        paymentReference: opts.paymentReference.trim(),
        payerName: opts.payerName.trim(),
        paidAt: opts.paidAt ? new Date(opts.paidAt) : null,
        submittedById: opts.staffId,
        tenantStatusBefore: tenant.activationStatus,
        referenceKey: reference,
        pendingKey: tenant.id,
        documents: {
          create: {
            tenantId: tenant.id,
            kind: "invoice",
            number: documentNumber("invoice"),
            billedToName: tenant.name,
            amountMinor: offer.amountMinor,
            currency: offer.currency,
            transactionReference: opts.paymentReference.trim(),
          },
        },
      },
      include: { partner: true, commission: true, documents: true },
    });
  } catch (err) {
    if (isUniqueViolation(err, "referenceKey")) {
      throw httpError(409, "duplicate_reference", "This payment reference has already been submitted.");
    }
    if (isUniqueViolation(err, "pendingKey")) {
      throw httpError(409, "submission_pending", "A setup payment for this store is already awaiting review.");
    }
    throw err;
  }
  await writeAudit({
    tenantId: tenant.id,
    actorKind: "merchant",
    actorId: opts.staffId,
    action: "activation.submitted",
    resource: "activation",
    resourceId: row.id,
    metadata: { plan: row.plan, amountMinor: row.amountMinor, currency: row.currency, referred: Boolean(partnerId) },
  });
  return { ...presentActivation(row), commission: null };
}

// ---- Platform staff ------------------------------------------------------------------------

const ACTIVATION_STATUSES = ["payment_submitted", "verified", "rejected", "reversed"] as const;

export async function listActivations(opts: { status?: string }) {
  const status = ACTIVATION_STATUSES.find((s) => s === opts.status);
  const rows = await prisma.activation.findMany({
    where: status ? { status } : {},
    include: { partner: true, commission: true, tenant: true, documents: true },
    orderBy: { createdAt: status === "payment_submitted" ? "asc" : "desc" },
    take: 200,
  });
  return { activations: rows.map(presentActivation) };
}

/**
 * Verify a submitted setup payment after checking it arrived. The transition is a conditional
 * write, so exactly one of any concurrent verifications wins, and a store can hold only one
 * verified activation. Its effects (opening the store, crediting the partner once) are applied
 * together; until they are, the activation cannot be reversed.
 */
export async function verifyActivation(operator: OperatorAuth, id: string, opts: { amountReceivedMinor: number; currency: string }) {
  const row = await prisma.activation.findUnique({ where: { id } });
  if (!row) throw httpError(404, "not_found", "Activation not found");
  if (row.status !== "payment_submitted") {
    throw httpError(409, "not_awaiting_verification", `This activation is ${row.status}.`);
  }
  if (opts.amountReceivedMinor !== row.amountMinor || opts.currency.trim().toUpperCase() !== row.currency) {
    throw httpError(400, "amount_mismatch", "The amount received does not match the setup fee for this plan.");
  }

  const verifiedAt = new Date();
  let claimed;
  try {
    claimed = await prisma.activation.updateMany({
      where: { id, status: "payment_submitted" },
      data: { status: "verified", pendingKey: null, activeKey: row.tenantId, verifiedById: operator.operatorId, verifiedAt },
    });
  } catch (err) {
    if (isUniqueViolation(err, "activeKey")) {
      throw httpError(409, "already_active", "This store already has a verified activation.");
    }
    throw err;
  }
  if (claimed.count !== 1) throw httpError(409, "not_awaiting_verification", "This activation was already reviewed.");

  const partner = row.partnerId ? await prisma.marketingPartner.findUnique({ where: { id: row.partnerId } }) : null;
  const credit = partner?.status === "active" ? commissionFor(row.amountMinor) : 0;
  const billedToName = (await prisma.tenant.findUniqueOrThrow({ where: { id: row.tenantId } })).name;
  let eventId: string | null;
  try {
    // The status change and its Portal event commit together, or not at all.
    eventId = await prisma.$transaction(async (tx) => {
      const event = await changeActivationStatus(tx, row.tenantId, "active", "verified");
      if (partner && credit > 0) {
        await tx.partnerCommission.create({
          data: {
            activationId: row.id,
            partnerId: partner.id,
            rateBps: PARTNER_COMMISSION_BPS,
            amountMinor: credit,
            currency: row.currency,
          },
        });
      }
      await tx.billingDocument.create({
        data: {
          activationId: row.id,
          tenantId: row.tenantId,
          kind: "receipt",
          number: documentNumber("receipt"),
          billedToName,
          amountMinor: row.amountMinor,
          currency: row.currency,
          transactionReference: row.paymentReference,
        },
      });
      await tx.activation.update({ where: { id }, data: { appliedAt: new Date() } });
      return event;
    });
  } catch (err) {
    // Undo the claim so the submission can be verified again; nothing else was written.
    await prisma.activation.updateMany({
      where: { id, status: "verified", appliedAt: null, verifiedAt },
      data: { status: "payment_submitted", pendingKey: row.tenantId, activeKey: null, verifiedById: null, verifiedAt: null },
    });
    throw err;
  }

  await writeAudit({
    tenantId: row.tenantId,
    actorKind: "platform_operator",
    actorId: operator.operatorId,
    action: "activation.verified",
    resource: "activation",
    resourceId: row.id,
    metadata: {
      amountMinor: row.amountMinor,
      currency: row.currency,
      commissionMinor: credit,
      ...(partner && !credit ? { commissionSkipped: `partner_${partner.status}` } : {}),
    },
  });
  sendActivationEventsInBackground([eventId]);
  return presentActivation(
    await prisma.activation.findUniqueOrThrow({ where: { id }, include: { partner: true, commission: true, tenant: true, documents: true } }),
  );
}

export async function rejectActivation(operator: OperatorAuth, id: string, reason: string) {
  const row = await prisma.activation.findUnique({ where: { id } });
  if (!row) throw httpError(404, "not_found", "Activation not found");
  // The reference is released so the owner can resubmit it once the payment really arrives.
  const rejected = await prisma.activation.updateMany({
    where: { id, status: "payment_submitted" },
    data: {
      status: "rejected",
      pendingKey: null,
      referenceKey: null,
      rejectedById: operator.operatorId,
      rejectedAt: new Date(),
      rejectedReason: reason.trim(),
    },
  });
  if (rejected.count !== 1) throw httpError(409, "not_awaiting_verification", `This activation is ${row.status}.`);
  await prisma.billingDocument.updateMany({
    where: { activationId: id, status: "draft" },
    data: { status: "void", voidedAt: new Date(), voidReason: "submission rejected" },
  });
  await writeAudit({
    tenantId: row.tenantId,
    actorKind: "platform_operator",
    actorId: operator.operatorId,
    action: "activation.rejected",
    resource: "activation",
    resourceId: row.id,
    metadata: { reason: reason.trim() },
  });
  return presentActivation(
    await prisma.activation.findUniqueOrThrow({ where: { id }, include: { partner: true, commission: true, tenant: true, documents: true } }),
  );
}

/**
 * Reverse a verified activation (for example, the transfer was recalled). The store returns to
 * the status it had before, its partner commission is reversed, and the payment reference stays
 * claimed so the same transfer cannot activate a store again.
 */
export async function reverseActivation(
  operator: OperatorAuth,
  id: string,
  reason: string,
  approval?: { approvalId: string; requestedById: string },
) {
  const row = await prisma.activation.findUnique({ where: { id } });
  if (!row) throw httpError(404, "not_found", "Activation not found");
  const reversed = await prisma.activation.updateMany({
    where: { id, status: "verified", appliedAt: { not: null } },
    data: {
      status: "reversed",
      activeKey: null,
      reversedById: operator.operatorId,
      reversedAt: new Date(),
      reversedReason: reason.trim(),
    },
  });
  if (reversed.count !== 1) {
    const current = await prisma.activation.findUnique({ where: { id } });
    if (current?.status === "verified") {
      throw httpError(409, "verification_in_progress", "Verification is still being applied. Try again shortly.");
    }
    throw httpError(409, "not_verified", `This activation is ${current?.status ?? row.status}.`);
  }
  const { eventId, commission } = await prisma.$transaction(async (tx) => {
    const event = await changeActivationStatus(tx, row.tenantId, row.tenantStatusBefore, "reversed", "active");
    const reversedCommissions = await tx.partnerCommission.updateMany({
      where: { activationId: id, status: "accrued" },
      data: { status: "reversed", reversedAt: new Date() },
    });
    await tx.billingDocument.updateMany({
      where: { activationId: id, status: "draft" },
      data: { status: "void", voidedAt: new Date(), voidReason: "activation reversed" },
    });
    return { eventId: event, commission: reversedCommissions };
  });
  await writeAudit({
    tenantId: row.tenantId,
    actorKind: "platform_operator",
    actorId: operator.operatorId,
    action: "activation.reversed",
    resource: "activation",
    resourceId: row.id,
    metadata: {
      reason: reason.trim(),
      commissionsReversed: commission.count,
      storeStatus: row.tenantStatusBefore,
      ...(approval ? { approvalId: approval.approvalId, requestedById: approval.requestedById } : {}),
    },
  });
  sendActivationEventsInBackground([eventId]);
  return presentActivation(
    await prisma.activation.findUniqueOrThrow({ where: { id }, include: { partner: true, commission: true, tenant: true, documents: true } }),
  );
}

// ---- Marketing partners ---------------------------------------------------------------------

function presentPartner(row: { id: string; code: string; name: string; email: string; status: string; createdAt: Date }) {
  return { id: row.id, code: row.code, name: row.name, email: row.email, status: row.status, createdAt: row.createdAt.toISOString() };
}

export async function createPartner(operator: OperatorAuth, opts: { code: string; name: string; email: string }) {
  const code = opts.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code)) {
    throw httpError(400, "invalid_partner_code", "Use 3–32 letters, digits or dashes for the referral code.");
  }
  let partner;
  try {
    partner = await prisma.marketingPartner.create({
      data: { code, name: opts.name.trim(), email: opts.email.trim().toLowerCase(), createdById: operator.operatorId },
    });
  } catch (err) {
    if (isUniqueViolation(err, "code")) throw httpError(409, "code_taken", "That referral code is already in use.");
    throw err;
  }
  await writeAudit({
    actorKind: "platform_operator",
    actorId: operator.operatorId,
    action: "partner.created",
    resource: "marketing_partner",
    resourceId: partner.id,
    metadata: { code },
  });
  return presentPartner(partner);
}

export async function setPartnerStatus(operator: OperatorAuth, id: string, status: "active" | "suspended") {
  const changed = await prisma.marketingPartner.updateMany({ where: { id, status: { not: status } }, data: { status } });
  const partner = await prisma.marketingPartner.findUnique({ where: { id } });
  if (!partner) throw httpError(404, "not_found", "Partner not found");
  if (changed.count === 1) {
    await writeAudit({
      actorKind: "platform_operator",
      actorId: operator.operatorId,
      action: status === "suspended" ? "partner.suspended" : "partner.reactivated",
      resource: "marketing_partner",
      resourceId: id,
    });
  }
  return presentPartner(partner);
}

type Totals = Record<string, number>;
function addTo(totals: Totals, currency: string, amount: number) {
  totals[currency] = (totals[currency] ?? 0) + amount;
}

export async function listPartners() {
  const partners = await prisma.marketingPartner.findMany({
    orderBy: { createdAt: "desc" },
    include: { commissions: true, activations: { select: { status: true } } },
  });
  return {
    partners: partners.map((p) => {
      const accrued: Totals = {};
      const reversed: Totals = {};
      for (const c of p.commissions) addTo(c.status === "accrued" ? accrued : reversed, c.currency, c.amountMinor);
      return {
        ...presentPartner(p),
        referrals: p.activations.length,
        verifiedReferrals: p.activations.filter((a) => a.status === "verified").length,
        commissionAccruedMinor: accrued,
        commissionReversedMinor: reversed,
      };
    }),
  };
}

export async function listCommissions(opts: { partnerId?: string; status?: string }) {
  const rows = await prisma.partnerCommission.findMany({
    where: {
      ...(opts.partnerId ? { partnerId: opts.partnerId } : {}),
      ...(opts.status === "accrued" || opts.status === "reversed" ? { status: opts.status } : {}),
    },
    include: { partner: true, activation: { include: { tenant: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return {
    commissions: rows.map((c) => ({
      id: c.id,
      partner: { id: c.partnerId, code: c.partner.code, name: c.partner.name },
      activationId: c.activationId,
      store: { slug: c.activation.tenant.slug, name: c.activation.tenant.name },
      rateBps: c.rateBps,
      amountMinor: c.amountMinor,
      currency: c.currency,
      status: c.status,
      payoutStatus: "disabled",
      createdAt: c.createdAt.toISOString(),
      reversedAt: c.reversedAt?.toISOString() ?? null,
    })),
  };
}

export async function platformOverview() {
  const [stores, activations, partners, commissions] = await Promise.all([
    prisma.tenant.groupBy({ by: ["activationStatus"], _count: { _all: true } }),
    prisma.activation.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.marketingPartner.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.partnerCommission.groupBy({ by: ["status", "currency"], _sum: { amountMinor: true } }),
  ]);
  const verified = await prisma.activation.groupBy({ by: ["currency"], where: { status: "verified" }, _sum: { amountMinor: true } });
  const counts = <T extends { _count: { _all: number } }>(rows: T[], key: keyof T) =>
    Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]));
  return {
    activationRequired: config.activationRequired,
    stores: counts(stores, "activationStatus"),
    activations: counts(activations, "status"),
    partners: counts(partners, "status"),
    verifiedSetupFeesMinor: Object.fromEntries(verified.map((r) => [r.currency, r._sum.amountMinor ?? 0])),
    commissionsMinor: commissions.map((r) => ({ status: r.status, currency: r.currency, amountMinor: r._sum.amountMinor ?? 0 })),
  };
}

export async function listStores() {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { storeConfig: true },
  });
  return {
    stores: tenants.map((t) => ({
      tenantId: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      activationStatus: t.activationStatus,
      currency: t.storeConfig?.defaultCurrency ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}
