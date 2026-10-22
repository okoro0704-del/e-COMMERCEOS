import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return `eco_${randomBytes(32).toString("base64url")}`;
}

/** Stored instead of a hash when an account has no password yet; it can never verify. */
export const UNUSABLE_PASSWORD_HASH = "!unset";

/** A ":temp" suffix marks a password someone else chose; it must be replaced at first sign-in. */
export function hashPassword(password: string, opts: { temporary?: boolean } = {}): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return opts.temporary ? `${salt}:${hash}:temp` : `${salt}:${hash}`;
}

export function isTemporaryPasswordHash(stored: string): boolean {
  return stored.endsWith(":temp");
}

export function isPasswordSet(stored: string): boolean {
  return stored !== UNUSABLE_PASSWORD_HASH;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function httpError(statusCode: number, code: string, message: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function driveUrl(namespace: string, key: string): string {
  return `drive://${namespace}/${key}`;
}
