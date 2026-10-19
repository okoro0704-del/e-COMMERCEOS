import type { FastifyInstance } from "fastify";
import { registerInternalProvisionRoutes } from "./routes/internal/provision.js";
import { registerLogisticsWebhookRoutes } from "./routes/internal/logistics-webhook.js";
import { registerInternalJobRoutes } from "./routes/internal/jobs.js";
import { registerAdminHandoffRoutes } from "./routes/internal/admin-handoff.js";
import { registerPlatformOperatorRoutes } from "./routes/internal/platform-operators.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProductRoutes } from "./routes/products.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerStorefrontRoutes } from "./routes/storefront.js";
import { registerMultiMerchantRoutes } from "./routes/multi-merchant.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerDigiPediaRoutes } from "./routes/digipedia.js";
import { registerLifeOsPublicRoutes } from "./routes/lifeos-public.js";
import { registerBusinessPublicationRoutes } from "./routes/business-publications.js";
import { registerActivationRoutes } from "./routes/activation.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerStoreSettingsRoutes } from "./routes/store-settings.js";
import { config } from "./config.js";
import { assertLifeOsPrimitivesReady, getLifeOsPrimitives } from "./services/lifeos/container.js";
import { onlinePaymentAvailability } from "./services/checkout.js";

export async function registerRoutes(app: FastifyInstance) {
  await registerInternalProvisionRoutes(app);
  await registerLogisticsWebhookRoutes(app);
  await registerInternalJobRoutes(app);
  await registerAdminHandoffRoutes(app);
  await registerPlatformOperatorRoutes(app);
  await registerAuthRoutes(app);
  await registerProductRoutes(app);
  await registerInventoryRoutes(app);
  await registerStorefrontRoutes(app);
  await registerMultiMerchantRoutes(app);
  await registerOrderRoutes(app);
  await registerDigiPediaRoutes(app);
  await registerLifeOsPublicRoutes(app);
  await registerBusinessPublicationRoutes(app);
  await registerActivationRoutes(app);
  await registerPlatformRoutes(app);
  await registerStoreSettingsRoutes(app);

  app.get("/health", async () => ({
    status: "ok" as const,
    service: "ecommerceos-api" as const,
    version: config.version,
    time: new Date().toISOString(),
  }));

  app.get("/health/primitives", async () => {
    const ready = await assertLifeOsPrimitivesReady();
    const c = getLifeOsPrimitives();
    return {
      ok: ready.ok,
      count: ready.count,
      ids: ready.ids,
      mode: config.primitivesMode,
      onlinePayment: onlinePaymentAvailability().available,
      health: {
        trustId: await c.trustId.health(),
        messaging: await c.messaging.health(),
        storage: await c.storage.health(),
        jobs: await c.jobs.health(),
        distributor: await c.distributor.health(),
        wallet: await c.wallet.health(),
      },
    };
  });
}
