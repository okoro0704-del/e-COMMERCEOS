import { randomUUID } from "node:crypto";
import type { DestinationOccupant, MarketplaceSeller } from "@ecommerceos/shared";
import { prisma } from "../db.js";

type TenantSettings = Record<string, unknown>;

async function readSettings(tenantId: string): Promise<TenantSettings> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const raw = tenant?.settings;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as TenantSettings) } : {};
}

async function writeSettings(tenantId: string, settings: TenantSettings) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: settings as object } });
  return settings;
}

export async function listOccupants(tenantId: string): Promise<DestinationOccupant[]> {
  const settings = await readSettings(tenantId);
  return Array.isArray(settings.destinationOccupants)
    ? (settings.destinationOccupants as DestinationOccupant[])
    : [];
}

export async function addOccupant(
  tenantId: string,
  input: Omit<DestinationOccupant, "id">,
): Promise<DestinationOccupant[]> {
  const settings = await readSettings(tenantId);
  const occupants = Array.isArray(settings.destinationOccupants)
    ? [...(settings.destinationOccupants as DestinationOccupant[])]
    : [];
  occupants.push({
    id: `occ_${randomUUID().slice(0, 8)}`,
    unitCode: input.unitCode,
    displayName: input.displayName,
    category: input.category,
    hours: input.hours,
    referencedTenantId: input.referencedTenantId ?? null,
    referencedSubdomain: input.referencedSubdomain ?? null,
  });
  settings.destinationOccupants = occupants;
  await writeSettings(tenantId, settings);
  return occupants;
}

export async function listSellers(tenantId: string): Promise<MarketplaceSeller[]> {
  const settings = await readSettings(tenantId);
  return Array.isArray(settings.marketplaceSellers)
    ? (settings.marketplaceSellers as MarketplaceSeller[])
    : [];
}

export async function addSeller(
  tenantId: string,
  input: Omit<MarketplaceSeller, "id">,
): Promise<MarketplaceSeller[]> {
  const settings = await readSettings(tenantId);
  const sellers = Array.isArray(settings.marketplaceSellers)
    ? [...(settings.marketplaceSellers as MarketplaceSeller[])]
    : [];
  sellers.push({
    id: `sel_${randomUUID().slice(0, 8)}`,
    displayName: input.displayName,
    status: input.status ?? "invited",
    sellerTenantId: input.sellerTenantId ?? null,
  });
  settings.marketplaceSellers = sellers;
  await writeSettings(tenantId, settings);
  return sellers;
}
