import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";

/**
 * digiconomy-service+jwt v1: per-request service credentials between Digiconomy services, as
 * agreed in the Portal ↔ eCommerceOS contract v2.
 *
 * Compact JWS, unpadded base64url, Ed25519 (EdDSA) over "<header>.<payload>".
 * Header {alg:"EdDSA", typ:"digiconomy-service+jwt", kid}. Claims:
 *   iss = sub (caller), aud (one receiver id), iat, exp (exp − iat ≤ 120 s), jti (single use),
 *   htm (method), htu (request path only), bdh (SHA-256 of the exact body bytes),
 *   idk (only with an Idempotency-Key header, equal to it).
 * The receiver pins keys by (iss, kid) and grants permissions from its own configuration only.
 */
export const TOKEN_TYPE = "digiconomy-service+jwt";
const MAX_LIFETIME_S = 120;
const SKEW_S = 30;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type ServiceTokenErrorCode =
  | "service_token_required"
  | "token_malformed"
  | "token_algorithm_refused"
  | "unknown_service_key"
  | "test_key_refused"
  | "bad_signature"
  | "wrong_audience"
  | "lifetime_refused"
  | "token_expired"
  | "token_bound_to_other_route"
  | "body_mismatch"
  | "idempotency_key_mismatch"
  | "token_replayed"
  | "permission_denied"
  | "service_replay_unavailable";

export class ServiceTokenError extends Error {
  constructor(
    readonly code: ServiceTokenErrorCode,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");
export const bodyHash = (body: Buffer | string) => b64url(createHash("sha256").update(body).digest());

export type TrustedServices = Record<string, { permissions: string[]; keys: Record<string, KeyObject> }>;

/**
 * Parses ECO_TRUSTED_SERVICES: {"<iss>": {"permissions": [...], "keys": {"<kid>": "<key>"}}}.
 * A key is base64 SPKI DER (Portal's format) or a raw 32-byte Ed25519 public key in base64url
 * (a JWK "x"); both become the same pinned key.
 */
export function parseTrustedServices(raw: string): TrustedServices {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as Record<string, { permissions?: unknown; keys?: Record<string, string> }>;
  const out: TrustedServices = {};
  for (const [iss, entry] of Object.entries(parsed)) {
    const permissions = Array.isArray(entry.permissions) ? entry.permissions.filter((p): p is string => typeof p === "string" && !p.includes("*")) : [];
    const keys: Record<string, KeyObject> = {};
    for (const [kid, value] of Object.entries(entry.keys ?? {})) {
      // Node's base64 decoder accepts both the standard and the URL-safe alphabet.
      const bytes = Buffer.from(value, "base64");
      const der = bytes.length === 32 ? Buffer.concat([SPKI_ED25519_PREFIX, bytes]) : bytes;
      keys[kid] = createPublicKey({ key: der, format: "der", type: "spki" });
    }
    out[iss] = { permissions, keys };
  }
  return out;
}

function decodeJson(segment: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new ServiceTokenError("token_malformed", 401);
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ServiceTokenError("token_malformed", 401);
  }
}

export type VerifyInput = {
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  method: string;
  path: string;
  body: Buffer;
  audience: string;
  permission: string;
  trusted: TrustedServices;
  production: boolean;
  /** Records the jti; resolves false if it was already used. */
  consumeJti: (iss: string, jti: string, expiresAt: Date) => Promise<boolean>;
  now?: number;
};

/** Verifies in the agreed order; a rejected token never reaches the replay store. */
export async function verifyServiceToken(input: VerifyInput): Promise<{ issuer: string; jti: string }> {
  const header = input.authorization ?? "";
  if (!header.startsWith("Bearer ")) throw new ServiceTokenError("service_token_required", 401);
  const token = header.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) throw new ServiceTokenError("token_malformed", 401);
  const [h, p, s] = parts as [string, string, string];
  const jose = decodeJson(h);
  const claims = decodeJson(p);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new ServiceTokenError("token_malformed", 401);
  if (jose.alg !== "EdDSA" || jose.typ !== TOKEN_TYPE) throw new ServiceTokenError("token_algorithm_refused", 401);
  const iss = claims.iss;
  const kid = jose.kid;
  if (typeof iss !== "string" || typeof kid !== "string" || claims.sub !== iss) throw new ServiceTokenError("token_malformed", 401);

  const key = input.trusted[iss]?.keys[kid];
  if (!key) throw new ServiceTokenError("unknown_service_key", 401);
  if (input.production && kid.startsWith("test-")) throw new ServiceTokenError("test_key_refused", 401);
  if (!verify(null, Buffer.from(`${h}.${p}`, "ascii"), key, Buffer.from(s, "base64url"))) {
    throw new ServiceTokenError("bad_signature", 401);
  }
  if (claims.aud !== input.audience) throw new ServiceTokenError("wrong_audience", 401);
  const iat = claims.iat;
  const exp = claims.exp;
  if (!Number.isInteger(iat) || !Number.isInteger(exp) || (exp as number) <= (iat as number) || (exp as number) - (iat as number) > MAX_LIFETIME_S) {
    throw new ServiceTokenError("lifetime_refused", 401);
  }
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (now > (exp as number) + SKEW_S || now < (iat as number) - SKEW_S) throw new ServiceTokenError("token_expired", 401);
  if (claims.htm !== input.method.toUpperCase() || claims.htu !== input.path) {
    throw new ServiceTokenError("token_bound_to_other_route", 401);
  }
  if (claims.bdh !== bodyHash(input.body)) throw new ServiceTokenError("body_mismatch", 401);
  if (input.idempotencyKey !== undefined || claims.idk !== undefined) {
    if (claims.idk !== input.idempotencyKey) throw new ServiceTokenError("idempotency_key_mismatch", 401);
  }
  if (!input.trusted[iss]!.permissions.includes(input.permission)) throw new ServiceTokenError("permission_denied", 403);
  const jti = claims.jti;
  if (typeof jti !== "string" || !jti || jti.length > 200) throw new ServiceTokenError("token_malformed", 401);
  if (!(await input.consumeJti(iss, jti, new Date(((exp as number) + SKEW_S) * 1000)))) {
    throw new ServiceTokenError("token_replayed", 401);
  }
  return { issuer: iss, jti };
}

/** The replay-store key: hex SHA-256 of iss + "\n" + jti, as agreed. */
export const jtiDigest = (iss: string, jti: string) => createHash("sha256").update(`${iss}\n${jti}`).digest("hex");

export function loadSigningKey(raw: string): KeyObject | null {
  if (!raw.trim()) return null;
  return createPrivateKey({ key: Buffer.from(raw.trim(), "base64url"), format: "der", type: "pkcs8" });
}

/** Mints a 60-second token for one request. */
export function signServiceToken(opts: {
  issuer: string;
  kid: string;
  key: KeyObject;
  audience: string;
  method: string;
  path: string;
  body: Buffer | string;
  idempotencyKey?: string;
  now?: number;
}) {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const jose = { alg: "EdDSA", typ: TOKEN_TYPE, kid: opts.kid };
  const claims = {
    iss: opts.issuer,
    sub: opts.issuer,
    aud: opts.audience,
    iat,
    exp: iat + 60,
    jti: randomUUID(),
    htm: opts.method.toUpperCase(),
    htu: opts.path,
    bdh: bodyHash(opts.body),
    ...(opts.idempotencyKey ? { idk: opts.idempotencyKey } : {}),
  };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(jose)))}.${b64url(Buffer.from(JSON.stringify(claims)))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput, "ascii"), opts.key))}`;
}
