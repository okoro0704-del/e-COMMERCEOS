export type AppEnv = "development" | "test" | "production";

export function resolveAppEnv(): AppEnv {
  const raw = (process.env.ECO_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (raw === "production" || raw === "prod") return "production";
  if (raw === "test") return "test";
  return "development";
}

const appEnv = resolveAppEnv();

export const config = {
  env: appEnv,
  port: Number(process.env.ECO_PORT ?? 8900),
  host: process.env.ECO_HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? (appEnv === "production" ? "" : "file:./dev.db"),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-session-secret-change-me",
  webhookSecret: process.env.WEBHOOK_SECRET ?? process.env.SESSION_SECRET ?? "dev-only-webhook-secret",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5190,http://localhost:5191")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  trustidApiUrl: process.env.TRUSTID_API_URL ?? "http://localhost:8791",
  trustidAudience: process.env.TRUSTID_AUDIENCE ?? "ecommerceos",
  primitivesMode: (process.env.PRIMITIVES_MODE ?? "local").toLowerCase() as "local" | "remote",
  elfcomUrl: process.env.ELFCOM_URL ?? "http://localhost:4000",
  sovereignDriveUrl: process.env.SOVEREIGN_DRIVE_URL ?? "http://localhost:4100",
  platformJobsUrl: process.env.PLATFORM_JOBS_URL ?? "http://localhost:3000",
  masterDistributorUrl: process.env.MASTER_DISTRIBUTOR_URL ?? "http://localhost:3100",
  fundzmanUrl: process.env.FUNDZMAN_URL ?? "http://localhost:4200",
  logisticsOsUrl: process.env.LOGISTICS_OS_URL ?? "http://localhost:4300",
  logisticsMode: (process.env.LOGISTICS_MODE ?? process.env.PRIMITIVES_MODE ?? "local").toLowerCase() as
    | "local"
    | "remote",
  primitivesServiceToken: process.env.PRIMITIVES_SERVICE_TOKEN ?? "dev-primitives-token",
  internalProvisionToken:
    process.env.INTERNAL_PROVISION_TOKEN ??
    process.env.PRIMITIVES_SERVICE_TOKEN ??
    "dev-primitives-token",
  storefrontLaunchUrlTemplate:
    process.env.STOREFRONT_LAUNCH_URL ?? "https://{subdomain}.lifeos.app",
  adminLaunchUrlTemplate:
    process.env.ADMIN_LAUNCH_URL ?? "https://{subdomain}.lifeos.app/admin",
  unpaidOrderTimeoutMs: Number(process.env.UNPAID_ORDER_TIMEOUT_MS ?? 30 * 60 * 1000),
  staffSessionTtlHours: 12,
  skipProductionAssert: process.env.ECO_SKIP_PRODUCTION_ASSERT === "true",
  version: "0.1.0",
};
