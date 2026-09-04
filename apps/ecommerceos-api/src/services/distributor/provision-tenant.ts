import { createHash, randomBytes } from "node:crypto";
import { ECOMMERCEOS_MANIFEST } from "@ecommerceos/shared";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { hashPassword, httpError } from "../../lib/crypto.js";
import { writeAudit } from "../../lib/audit.js";
import { seedStoreDefaults } from "./provision-seed.js";
import { getDistributorProvider, getLifeOsPrimitives } from "../lifeos/container.js";

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
  adminStaff?: { email: string; displayName: string; role?: string; password?: string };
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
};

function launchUrl(template: string, subdomain: string): string {
  return template.replaceAll("{subdomain}", subdomain);
}

/**
 * Provision an ECommerceOS tenant from Master Distributor / LifeOS Portal.
 * Reads ECommerceOSManifest, seeds categories + store settings, registers primitive bindings.
 */
export async function provisionEcommerceTenant(input: ProvisionTenantInput) {
  const slug = (input.slug ?? input.subdomain).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const seedMode = input.seed ?? "default";
  const modules = input.modules?.length ? input.modules : [...ECOMMERCEOS_MANIFEST.defaultModules];

  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
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
      businessType: ECOMMERCEOS_MANIFEST.brandDefaults.businessType,
      status: "active",
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
      },
    },
  });

  for (const moduleId of modules) {
    await prisma.tenantModule.create({
      data: { tenantId: tenant.id, moduleId, enabled: true, config: {} },
    });
  }

  const adminEmail = input.adminStaff?.email ?? `owner@${slug}.commerce.local`;
  const adminPassword = input.adminStaff?.password ?? `Tmp-${randomBytes(6).toString("hex")}!`;
  const staff = await prisma.staffMember.create({
    data: {
      tenantId: tenant.id,
      displayName: input.adminStaff?.displayName ?? "Owner",
      email: adminEmail,
      passwordHash: hashPassword(adminPassword),
      role: input.adminStaff?.role ?? "owner",
      status: "active",
    },
  });

  if (seedMode === "default") {
    await seedStoreDefaults({
      tenantId: tenant.id,
      displayName: input.displayName,
      subdomain: slug,
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
    temporaryAdminPassword: input.adminStaff?.password ? undefined : adminPassword,
    launchUrls: {
      storefront: storefrontUrl,
      admin: adminConsoleUrl,
    },
  };
}
