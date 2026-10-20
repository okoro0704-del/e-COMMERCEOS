import type { AppEnv } from "../config.js";
import { unsafeProductionOrigins } from "./cors.js";
import { loadSigningKey, parseTrustedServices } from "./service-token.js";

/** Development values shipped in this repo and in LifeOS Portal; none may guard production. */
export const KNOWN_INSECURE_SECRETS = new Set([
  "dev-primitives-token",
  "dev-only-session-secret-change-me",
  "dev-only-webhook-secret",
  "change-me",
  "replace-me",
  "secret",
]);

export type SafetyConfig = {
  env: AppEnv;
  protectedCheckoutEnabled: boolean;
  internalProvisionToken: string;
  primitivesMode: string;
  logisticsMode: string;
  platformAdminToken?: string;
  operatorMfaKey?: string;
  corsOrigins?: readonly string[];
  serviceAuthMode?: "shared" | "signed";
  trustedServicesJson?: string;
  serviceSigningKey?: string;
  serviceSigningKid?: string;
};

export type SafetyIssue = { key: string; message: string };

/** Problems that must stop a production boot. Non-production environments are not checked. */
export function productionSafetyIssues(cfg: SafetyConfig): SafetyIssue[] {
  if (cfg.env !== "production") return [];
  const issues: SafetyIssue[] = [];
  if (cfg.protectedCheckoutEnabled) {
    issues.push({
      key: "ECO_PROTECTED_CHECKOUT_ENABLED",
      message: "protected checkout cannot be enabled: this build has no verified payment provider integration",
    });
  }
  const token = cfg.internalProvisionToken.trim();
  if (!token) {
    issues.push({ key: "INTERNAL_PROVISION_TOKEN", message: "is required in production" });
  } else if (KNOWN_INSECURE_SECRETS.has(token)) {
    issues.push({ key: "INTERNAL_PROVISION_TOKEN", message: "refuses a publicly known development token" });
  }
  // Optional; when set it creates platform operators, so it must be strong and not shared with Portal.
  const platformToken = (cfg.platformAdminToken ?? "").trim();
  if (platformToken) {
    if (platformToken.length < 32 || KNOWN_INSECURE_SECRETS.has(platformToken)) {
      issues.push({ key: "ECO_PLATFORM_ADMIN_TOKEN", message: "must be at least 32 characters and not a known value" });
    } else if (platformToken === token) {
      issues.push({ key: "ECO_PLATFORM_ADMIN_TOKEN", message: "must differ from INTERNAL_PROVISION_TOKEN" });
    }
  }
  const mfaKey = (cfg.operatorMfaKey ?? "").trim();
  if (mfaKey && (mfaKey.length < 32 || KNOWN_INSECURE_SECRETS.has(mfaKey) || mfaKey === token || mfaKey === platformToken)) {
    issues.push({ key: "ECO_OPERATOR_MFA_KEY", message: "must be at least 32 characters and not reuse another token" });
  }
  issues.push(...serviceCredentialIssues(cfg));
  const unsafeOrigins = unsafeProductionOrigins(cfg.corsOrigins ?? []);
  if (unsafeOrigins.length) {
    issues.push({
      key: "CORS_ORIGINS",
      message: `must list https origins Digiconomy controls; refused: ${unsafeOrigins.join(", ")}`,
    });
  }
  return issues;
}

/** Signed service credentials: parseable, no test keys, and signed-only mode has keys to check. */
function serviceCredentialIssues(cfg: SafetyConfig): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  let trusted: ReturnType<typeof parseTrustedServices> = {};
  try {
    trusted = parseTrustedServices(cfg.trustedServicesJson ?? "");
  } catch {
    issues.push({ key: "ECO_TRUSTED_SERVICES", message: "is not valid JSON with Ed25519 public keys" });
  }
  if (Object.values(trusted).some((t) => Object.keys(t.keys).some((kid) => kid.startsWith("test-")))) {
    issues.push({ key: "ECO_TRUSTED_SERVICES", message: "must not trust test- keys in production" });
  }
  if (cfg.serviceAuthMode === "signed" && !Object.keys(trusted).length) {
    issues.push({ key: "ECO_TRUSTED_SERVICES", message: "is required when ECO_SERVICE_AUTH_MODE=signed" });
  }
  if ((cfg.serviceSigningKey ?? "").trim()) {
    try {
      loadSigningKey(cfg.serviceSigningKey ?? "");
    } catch {
      issues.push({ key: "ECO_SERVICE_SIGNING_KEY", message: "is not a base64url PKCS#8 Ed25519 private key" });
    }
    if (!(cfg.serviceSigningKid ?? "").trim() || (cfg.serviceSigningKid ?? "").startsWith("test-")) {
      issues.push({ key: "ECO_SERVICE_SIGNING_KID", message: "must be set and must not be a test- key id" });
    }
  }
  return issues;
}

/** Conditions worth surfacing at boot that do not block it. */
export function productionSafetyWarnings(cfg: SafetyConfig): string[] {
  if (cfg.env !== "production") return [];
  const warnings: string[] = [];
  if (cfg.primitivesMode === "local") {
    warnings.push(
      "PRIMITIVES_MODE=local: buyer identity, messaging, storage and jobs are in-process stand-ins; online payment stays disabled",
    );
  }
  if (cfg.logisticsMode === "local") {
    warnings.push("LOGISTICS_MODE=local: dispatch jobs are not sent to LogisticsOS");
  }
  if (cfg.internalProvisionToken.trim().length > 0 && cfg.internalProvisionToken.trim().length < 32) {
    warnings.push("INTERNAL_PROVISION_TOKEN is shorter than 32 characters");
  }
  return warnings;
}

export function assertProductionSafety(cfg: SafetyConfig): string[] {
  const issues = productionSafetyIssues(cfg);
  if (issues.length) {
    throw new Error(
      `Unsafe production configuration: ${issues.map((issue) => `${issue.key} ${issue.message}`).join("; ")}`,
    );
  }
  return productionSafetyWarnings(cfg);
}
