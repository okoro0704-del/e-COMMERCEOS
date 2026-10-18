import type { AppEnv } from "../config.js";

/**
 * Hosting suffixes where anyone can publish a site; a subdomain wildcard on one of these would
 * let any stranger's page call the API with credentials.
 */
export const SHARED_HOSTING_SUFFIXES = [
  "netlify.app",
  "vercel.app",
  "up.railway.app",
  "railway.app",
  "github.io",
  "pages.dev",
  "onrender.com",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
];

function subdomainPattern(entry: string) {
  const match = /^https:\/\/\*\.([a-z0-9-]+(\.[a-z0-9-]+)+)$/i.exec(entry.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * CORS_ORIGINS entries: exact origins ("https://shop.example"), or "https://*.example" for
 * per-store subdomains of a domain Digiconomy controls. "*" and localhost are development only.
 */
export function originAllowed(origin: string, allowed: readonly string[], env: AppEnv): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  for (const entry of allowed) {
    if (entry === "*") {
      if (env !== "production") return true;
      continue;
    }
    if (entry === origin) return true;
    const domain = subdomainPattern(entry);
    if (domain && url.protocol === "https:" && !url.port && url.hostname.endsWith(`.${domain}`)) return true;
  }
  return env !== "production" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** CORS_ORIGINS entries that must never be used in production. */
export function unsafeProductionOrigins(allowed: readonly string[]): string[] {
  return allowed.filter((entry) => {
    if (entry === "*") return true;
    const domain = subdomainPattern(entry);
    if (domain) return SHARED_HOSTING_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`));
    if (entry.includes("*")) return true;
    try {
      const url = new URL(entry);
      return url.protocol !== "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
    } catch {
      return true;
    }
  });
}
