import { ECOMMERCEOS_DEFAULT_SEED, ECOMMERCEOS_MANIFEST } from "@ecommerceos/shared";
import { prisma } from "../../db.js";

export async function seedStoreDefaults(opts: {
  tenantId: string;
  displayName: string;
  subdomain: string;
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
}) {
  const seed = ECOMMERCEOS_DEFAULT_SEED;

  for (const category of seed.categories) {
    await prisma.productCategory.create({
      data: {
        tenantId: opts.tenantId,
        code: category.code,
        name: category.name,
        sortOrder: category.sortOrder,
        status: "active",
      },
    });
  }

  await prisma.storeConfig.create({
    data: {
      tenantId: opts.tenantId,
      storeName: opts.displayName,
      subdomain: opts.subdomain,
      pickupAddressLine1: opts.pickup?.addressLine1 ?? seed.store.pickupAddressLine1,
      pickupCity: opts.pickup?.city ?? seed.store.pickupCity,
      pickupRegion: opts.pickup?.region,
      pickupPostalCode: opts.pickup?.postalCode,
      pickupCountry: opts.pickup?.country ?? seed.store.pickupCountry,
      pickupLat: opts.pickup?.lat ?? seed.store.pickupLat,
      pickupLng: opts.pickup?.lng ?? seed.store.pickupLng,
      defaultCurrency: opts.defaultCurrency ?? seed.store.defaultCurrency,
      deliveryRadiusKm: opts.deliveryRadiusKm ?? seed.store.deliveryRadiusKm,
      platformCommissionBps: seed.store.platformCommissionBps,
      deliveryFeeMinor: seed.store.deliveryFeeMinor,
    },
  });

  return { categories: seed.categories.length, manifestVersion: ECOMMERCEOS_MANIFEST.version };
}
