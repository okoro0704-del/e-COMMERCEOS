import { createHash, randomBytes } from "node:crypto";
import { ECOMMERCEOS_MANIFEST, ecommerceVerticalPreset } from "@ecommerceos/shared";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { hashPassword, httpError, UNUSABLE_PASSWORD_HASH } from "../../lib/crypto.js";
import { passwordProblem } from "../../lib/password-policy.js";
import { writeAudit } from "../../lib/audit.js";
import { seedStoreDefaults } from "./provision-seed.js";
import { getDistributorProvider, getLifeOsPrimitives } from "../lifeos/container.js";
import { initialActivationStatus } from "../activation.js";

export type ProvisionTenantInput = {
  distributorTenantId: string;
  tenantId?: string;
  subdomain: string;
  slug?: string;
  displayName: string;
  customDomain?: string;
  brand?: { primaryColor?: string; logoUrl?: string };
  oauthDestinations?: string[];
  modules?: string[];
  seed?: "default" | "none";
  trustId?: { audience?: string; businessPublicId?: string };
  adminStaff?: {
    email: string;
    displayName: string;
    role?: string;
    password?: string;
    /** The password was chosen by someone other than the owner; it must be replaced at first sign-in. */
    temporaryPassword?: boolean;
  };
  /** Stable identity of the store owner in the calling platform (LifeOS Portal subject or Trust ID). */
  owner?: { subject: string };
  organization?: { slug?: string; name?: string };
  manifestVersion?: string;
  pickup?: {
    addressLine1?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    lat?: number;
    lng?: number;
  };
  defaultCurrency?: string;
  deliveryRadiusKm?: number;
  walletPayoutAccount?: string;
  verticalId?: string;
  hasPhysicalAddress?: boolean;
};

function launchUrl(template: string, subdomain: string): string {
  return template.replaceAll("{subdomain}", subdomain);
}

/**
 * Provision an ECommerceOS tenant from Master Distributor / LifeOS Portal.
 * Reads ECommerceOSManifest, seeds categories + store settings, registers primitive bindings.
 */
export async function provisionEcommerceTenant(input: ProvisionTenantInput) {
  const preset = ecommerceVerticalPreset(input.verticalId);
  const slug = (input.slug ?? input.subdomain).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const seedMode = input.seed ?? "default";
  const modules = input.modules?.length ? input.modules : [...preset.modules];

  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    // A retry by the same owner returns the store it already created; anyone else gets a conflict.
    const replay = input.owner?.subject ? await replayForOwner(existing.id, input.owner.subject) : null;
    if (replay) return replay;
    throw httpError(409, "conflict", `Tenant slug already exists: ${slug}`);
  }

  const primitives = getLifeOsPrimitives();
  const primitiveBindings = {
    "trust-id": { bound: primitives.trustId.bound, audience: input.trustId?.audience ?? config.trustidAudience },
    elfcom: { bound: primitives.messaging.bound },
    "sovereign-drive": { bound: primitives.storage.bound },
    "platform-jobs": { bound: primitives.jobs.bound },
    "master-distributor": { bound: primitives.distributor.bound },
    fundzman: { bound: primitives.wallet.bound },
  };

  const deploy = await getDistributorProvider().requestDeploy({
    shellId: "ecommerceos",
    artifactTag: `tenant:${slug}`,
    environment: config.env === "production" ? "production" : "staging",
  });

  const orgSlug = input.organization?.slug ?? `${slug}-group`.replace(/[^a-z0-9-]/g, "-");
  const organization = await prisma.organization.upsert({
    where: { slug: orgSlug },
    create: {
      slug: orgSlug,
      name: input.organization?.name ?? `${input.displayName} Group`,
      status: "active",
      metadata: { distributorTenantId: input.distributorTenantId },
    },
    update: {
      name: input.organization?.name ?? `${input.displayName} Group`,
    },
  });

  const tenant = await prisma.tenant.create({
    data: {
      organizationId: organization.id,
      slug,
      name: input.displayName,
      businessType: preset.id,
      status: "active",
      activationStatus: initialActivationStatus(),
      lifeosBusinessId: input.trustId?.businessPublicId ?? input.distributorTenantId,
      logoUrl: input.brand?.logoUrl,
      primaryColor: input.brand?.primaryColor ?? ECOMMERCEOS_MANIFEST.brandDefaults.primaryColor,
      settings: {
        distributorTenantId: input.distributorTenantId,
        customDomain: input.customDomain ?? null,
        oauthDestinations: input.oauthDestinations ?? ECOMMERCEOS_MANIFEST.install.oauthDestinations,
        trustIdAudience: input.trustId?.audience ?? config.trustidAudience,
        manifestVersion: input.manifestVersion ?? ECOMMERCEOS_MANIFEST.version,
        provisionedAt: new Date().toISOString(),
        enabledModules: modules,
        primitiveBindings,
        distributorDeploymentId: deploy.deploymentId,
        walletPayoutAccount: input.walletPayoutAccount ?? null,
        verticalId: preset.id,
        operatingModel: preset.operatingModel,
        hasPhysicalAddress: input.hasPhysicalAddress ?? preset.hasPhysicalAddress,
        destinationOccupants: (preset.seedOccupants ?? []).map((row, index) => ({
          id: `occ_seed_${index + 1}`,
          ...row,
        })),
        marketplaceSellers: [] as Array<{ id: string; displayName: string; status: string }>,
        wholesale: preset.wholesale ?? null,
      },
    },
  });

  for (const moduleId of modules) {
    await prisma.tenantModule.create({
      data: { tenantId: tenant.id, moduleId, enabled: true, config: {} },
    });
  }

  const adminEmail = (input.adminStaff?.email ?? `owner@${slug}.commerce.local`).trim().toLowerCase();
  const credentials = ownerCredentials(input, adminEmail);
  const staff = await prisma.staffMember.create({
    data: {
      tenantId: tenant.id,
      displayName: input.adminStaff?.displayName ?? "Owner",
      email: adminEmail,
      passwordHash: credentials.passwordHash,
      role: input.adminStaff?.role ?? "owner",
      trustId: input.owner?.subject ?? null,
      status: "active",
    },
  });

  if (seedMode === "default") {
    await seedStoreDefaults({
      tenantId: tenant.id,
      displayName: input.displayName,
      subdomain: slug,
      verticalId: preset.id,
      pickup: input.pickup,
      defaultCurrency: input.defaultCurrency,
      deliveryRadiusKm: input.deliveryRadiusKm,
    });
  }

  await writeAudit({
    tenantId: tenant.id,
    actorKind: "system",
    action: "distributor.provision",
    resource: "tenant",
    resourceId: tenant.id,
    metadata: {
      distributorTenantId: input.distributorTenantId,
      slug,
      modules,
      seed: seedMode,
      credentialSetup: credentials.setup,
      ownerBound: Boolean(input.owner?.subject),
      fingerprint: createHash("sha256").update(`${slug}:${tenant.id}`).digest("hex").slice(0, 16),
    },
  });

  const storefrontUrl = launchUrl(config.storefrontLaunchUrlTemplate, slug);
  const adminConsoleUrl = launchUrl(config.adminLaunchUrlTemplate, slug);

  return {
    ok: true as const,
    tenantId: tenant.id,
    storefrontUrl,
    adminConsoleUrl,
    organizationId: organization.id,
    staffId: staff.id,
    slug: tenant.slug,
    modulesEnabled: modules,
    seedApplied: seedMode === "default",
    primitiveBindings,
    credentialSetup: credentials.setup,
    temporaryAdminPassword: credentials.temporaryPassword,
    launchUrls: {
      storefront: storefrontUrl,
      admin: adminConsoleUrl,
    },
    verticalId: preset.id,
    operatingModel: preset.operatingModel,
  };
}

type CredentialSetup = "password" | "temporary_password" | "portal_handoff";

/**
 * How the owner will first sign in. A supplied password is used only if it passes policy
 * (publicly known defaults never do). With an owner identity and no usable password the
 * account has no password until the owner sets one through a Portal handoff.
 */
function ownerCredentials(
  input: ProvisionTenantInput,
  adminEmail: string,
): { passwordHash: string; setup: CredentialSetup; temporaryPassword?: string } {
  const supplied = input.adminStaff?.password;
  if (supplied && !passwordProblem(supplied, adminEmail)) {
    const temporary = input.adminStaff?.temporaryPassword === true;
    return {
      passwordHash: hashPassword(supplied, { temporary }),
      setup: temporary ? "temporary_password" : "password",
    };
  }
  if (supplied || input.owner?.subject) {
    return { passwordHash: UNUSABLE_PASSWORD_HASH, setup: "portal_handoff" };
  }
  const generated = `Tmp-${randomBytes(6).toString("hex")}!`;
  return {
    passwordHash: hashPassword(generated, { temporary: true }),
    setup: "temporary_password",
    temporaryPassword: generated,
  };
}

async function replayForOwner(tenantId: string, ownerSubject: string) {
  const owner = await prisma.staffMember.findFirst({ where: { tenantId, role: "owner", trustId: ownerSubject } });
  if (!owner) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { storeConfig: true, modules: { where: { enabled: true } } },
  });
  if (!tenant) return null;
  const settings =
    tenant.settings && typeof tenant.settings === "object" && !Array.isArray(tenant.settings)
      ? (tenant.settings as Record<string, unknown>)
      : {};
  const storefrontUrl = launchUrl(config.storefrontLaunchUrlTemplate, tenant.slug);
  const adminConsoleUrl = launchUrl(config.adminLaunchUrlTemplate, tenant.slug);
  return {
    ok: true as const,
    replayed: true as const,
    tenantId: tenant.id,
    storefrontUrl,
    adminConsoleUrl,
    organizationId: tenant.organizationId,
    staffId: owner.id,
    slug: tenant.slug,
    modulesEnabled: tenant.modules.map((m) => m.moduleId),
    seedApplied: Boolean(tenant.storeConfig),
    primitiveBindings: settings.primitiveBindings,
    credentialSetup: undefined,
    temporaryAdminPassword: undefined,
    launchUrls: { storefront: storefrontUrl, admin: adminConsoleUrl },
    verticalId: typeof settings.verticalId === "string" ? settings.verticalId : tenant.businessType,
    operatingModel: typeof settings.operatingModel === "string" ? settings.operatingModel : "store",
  };
}
