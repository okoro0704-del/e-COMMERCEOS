import { createHash } from "node:crypto";

/**
 * SHA-256 of passwords that have been published (in source code or test fixtures)
 * and must never authenticate anyone. Only hashes are kept here.
 * - LifeOS Portal hardcoded EcommerceOS owner default (Phase 0 audit).
 */
const COMPROMISED_PASSWORD_SHA256 = new Set([
  "a109e36947ad56de1dca1cc49f0ef8ac9ad9a7b1aa0df41fb3c4cb73c1ff01ea",
  // Operators can deny newly leaked passwords by hash without a code change.
  ...(process.env.ECO_COMPROMISED_PASSWORD_SHA256 ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value)),
]);

export const MIN_PASSWORD_LENGTH = 12;

export function isCompromisedPassword(password: string): boolean {
  return COMPROMISED_PASSWORD_SHA256.has(createHash("sha256").update(password).digest("hex"));
}

/** Returns why a new password is unacceptable, or null when it may be used. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 1024) return "Password is too long.";
  if (isCompromisedPassword(password)) return "This password is publicly known and cannot be used.";
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return "Do not include your email name in the password.";
  }
  return null;
}
