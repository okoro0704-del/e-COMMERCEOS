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
  port: Number(process.env.PORT ?? process.env.ECO_PORT ?? 8900),
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
  // No public fallback in production: an empty token makes every internal route reject.
  internalProvisionToken:
    process.env.INTERNAL_PROVISION_TOKEN ??
    process.env.PRIMITIVES_SERVICE_TOKEN ??
    (appEnv === "production" ? "" : "dev-primitives-token"),
  storefrontLaunchUrlTemplate:
    process.env.STOREFRONT_LAUNCH_URL ?? "https://{subdomain}.getlifeos.app",
  adminLaunchUrlTemplate:
    process.env.ADMIN_LAUNCH_URL ?? "https://{subdomain}.getlifeos.app/admin",
  portalApiUrl: (process.env.PORTAL_API_URL ?? "").replace(/\/$/, ""),
  portalInternalToken:
    process.env.PORTAL_INTERNAL_TOKEN ??
    process.env.INTERNAL_PROVISION_TOKEN ??
    process.env.PRIMITIVES_SERVICE_TOKEN ??
    "dev-primitives-token",
  digipediaUrl: (process.env.DIGIPEDIA_URL ?? "https://digiconomy-digipedia-production.up.railway.app").replace(
    /\/$/,
    "",
  ),
  digipediaManageKey: process.env.DIGIPEDIA_MANAGE_KEY ?? "",
  unpaidOrderTimeoutMs: Number(process.env.UNPAID_ORDER_TIMEOUT_MS ?? 30 * 60 * 1000),
  staffSessionTtlHours: 12,
  /**
   * Customer online payment (FundzMan escrow path). Off unless explicitly enabled, and
   * refused in production because this build has no verified payment provider integration.
   */
  protectedCheckoutEnabled: process.env.ECO_PROTECTED_CHECKOUT_ENABLED === "true",
  /**
   * Paid brand setup. When required, stores provisioned from now on stay closed to buyers until
   * platform staff verify their setup payment; stores created earlier are grandfathered.
   */
  activationRequired: process.env.ECO_ACTIVATION_REQUIRED === "true",
  /** Shown to owners with the setup fee: how to pay outside the platform. Empty until approved. */
  setupPaymentInstructions: process.env.ECO_SETUP_PAYMENT_INSTRUCTIONS ?? "",
  /** Early-adopter setup price. Off until Digiconomy confirms eligibility, amount and currency. */
  earlyAdopter: {
    enabled: process.env.ECO_EARLY_ADOPTER_ENABLED === "true",
    amountMinor: Number(process.env.ECO_EARLY_ADOPTER_AMOUNT_MINOR ?? 2000),
    currency: (process.env.ECO_EARLY_ADOPTER_CURRENCY ?? "USD").trim().toUpperCase(),
    /** ISO date after which the offer ends; empty for no end date. */
    until: process.env.ECO_EARLY_ADOPTER_UNTIL ?? "",
    /** Most verified early-adopter activations; 0 for no limit. */
    limit: Number(process.env.ECO_EARLY_ADOPTER_LIMIT ?? 0),
  },
  /** Bootstraps platform operators. Unset disables the route; never the Portal service token. */
  platformAdminToken: process.env.ECO_PLATFORM_ADMIN_TOKEN ?? "",
  platformSessionTtlHours: 8,
  /** Operator sessions also end after this long without activity. */
  platformIdleTimeoutMinutes: Number(process.env.ECO_PLATFORM_IDLE_MINUTES ?? 30),
  /** Encrypts operator TOTP secrets. Unset: operator sign-in is refused (MFA cannot be enforced). */
  operatorMfaKey: process.env.ECO_OPERATOR_MFA_KEY ?? "",
  /** How long a bank-transfer order is held for the customer to pay before it is released. */
  bankTransferWindowHours: Number(process.env.ECO_BANK_TRANSFER_WINDOW_HOURS ?? 48),
  /**
   * Service-to-service credentials (digiconomy-service+jwt v1). "shared": the legacy shared
   * bearer token, plus signed tokens from trusted services; "signed": signed tokens only on the
   * Portal-facing routes (the shared token stays only for internal jobs and logistics).
   */
  serviceAuthMode: (process.env.ECO_SERVICE_AUTH_MODE ?? "shared").toLowerCase() === "signed" ? ("signed" as const) : ("shared" as const),
  /** {"<issuer>": {"permissions": [...], "keys": {"<kid>": "<public key>"}}}; permissions come only from here. */
  trustedServicesJson: process.env.ECO_TRUSTED_SERVICES ?? "",
  /** This service's Ed25519 signing key (base64url PKCS#8 DER) and key id, for calls to Portal. */
  serviceSigningKey: process.env.ECO_SERVICE_SIGNING_KEY ?? "",
  serviceSigningKid: process.env.ECO_SERVICE_SIGNING_KID ?? "",
  serviceId: "ecommerceos",
  portalServiceId: "lifeos-portal",
  version: "0.1.0",
};
