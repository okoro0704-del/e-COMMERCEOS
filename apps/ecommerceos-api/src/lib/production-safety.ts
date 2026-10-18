import type { AppEnv } from "../config.js";

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
