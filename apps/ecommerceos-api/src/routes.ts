import type { FastifyInstance } from "fastify";
import { registerInternalProvisionRoutes } from "./routes/internal/provision.js";
import { registerLogisticsWebhookRoutes } from "./routes/internal/logistics-webhook.js";
import { registerInternalJobRoutes } from "./routes/internal/jobs.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProductRoutes } from "./routes/products.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerStorefrontRoutes } from "./routes/storefront.js";
import { registerMultiMerchantRoutes } from "./routes/multi-merchant.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerDigiPediaRoutes } from "./routes/digipedia.js";
import { config } from "./config.js";
import { assertLifeOsPrimitivesReady, getLifeOsPrimitives } from "./services/lifeos/container.js";

export async function registerRoutes(app: FastifyInstance) {
  await registerInternalProvisionRoutes(app);
  await registerLogisticsWebhookRoutes(app);
  await registerInternalJobRoutes(app);
  await registerAuthRoutes(app);
  await registerProductRoutes(app);
  await registerInventoryRoutes(app);
  await registerStorefrontRoutes(app);
  await registerMultiMerchantRoutes(app);
  await registerOrderRoutes(app);
  await registerDigiPediaRoutes(app);

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
