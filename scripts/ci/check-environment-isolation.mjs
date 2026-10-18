#!/usr/bin/env node
/**
 * Environment isolation checks (CI). Static, no network, no dependencies.
 *
 * Fails when committed configuration could send preview, CI or staging traffic to production:
 *  1. Netlify Deploy Previews and branch deploys must override VITE_API_URL with a reserved
 *     `.invalid` host (netlify.toml values override the site's UI variables).
 *  2. The storefront web app must not hardcode a production API host and must fall back to its
 *     own origin when VITE_API_URL is unset.
 *  3. The CI workflow must use a read-only token, reference no secrets, and pin every outbound
 *     base URL the API reads from its environment to a `.invalid` host.
 *  4. Production hosts used as code defaults in the API config must stay on the reviewed list.
 *  5. No environment files with values are committed (only empty `.env.example` templates).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

const PRODUCTION_HOST = /(-production[a-z0-9-]*\.up\.railway\.app|(^|\.)getlifeos\.app$|(^|\.)lifeos\.app$)/i;
const hostOf = (value) => {
  try {
    return new URL(value.replace(/\{[a-z]+\}/gi, "x")).hostname;
  } catch {
    return "";
  }
};

// 1. Netlify preview and branch-deploy contexts.
{
  const toml = read("netlify.toml");
  for (const context of ["deploy-preview", "branch-deploy"]) {
    const section = toml.match(new RegExp(`\\[context\\.${context}\\.environment\\]([\\s\\S]*?)(?=\\n\\[|$)`));
    const value = section?.[1].match(/VITE_API_URL\s*=\s*"([^"]*)"/)?.[1];
    if (!value) fail(`netlify.toml: [context.${context}.environment] must set VITE_API_URL`);
    else if (!hostOf(value).endsWith(".invalid")) fail(`netlify.toml: ${context} VITE_API_URL must use a .invalid host, found ${hostOf(value) || value}`);
  }
}

// 2. Web app: no production API host, same-origin fallback.
{
  const files = execFileSync("git", ["ls-files", "apps/ecommerceos-web/src"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of files) {
    for (const m of read(file).matchAll(/https?:\/\/([a-z0-9.-]+\.up\.railway\.app)/gi)) fail(`${file}: hardcoded API host ${m[1]}`);
  }
  const api = read("apps/ecommerceos-web/src/lib/api.ts");
  if (!/import\.meta\.env\.VITE_API_URL \?\? ""/.test(api)) fail("apps/ecommerceos-web/src/lib/api.ts: VITE_API_URL must fall back to the same origin (\"\")");
}

// 3. CI workflow: read-only token, no secrets, outbound URLs pinned to .invalid.
{
  const workflow = read(".github/workflows/ci.yml");
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(workflow)) fail(".github/workflows/ci.yml: top-level permissions must be `contents: read`");
  if (/\$\{\{\s*secrets\./.test(workflow)) fail(".github/workflows/ci.yml: must not reference secrets");
  // Every *_URL the API config reads, except the database and the link templates it never fetches.
  const notFetched = new Set(["DATABASE_URL", "STOREFRONT_LAUNCH_URL", "ADMIN_LAUNCH_URL", "PUBLIC_API_URL", "ECOMMERCEOS_PUBLIC_API_URL"]);
  const config = read("apps/ecommerceos-api/src/config.ts");
  const outbound = [...new Set([...config.matchAll(/process\.env\.([A-Z0-9_]+_URL)\b/g)].map((m) => m[1]))].filter((k) => !notFetched.has(k));
  for (const key of outbound) {
    const value = workflow.match(new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`, "m"))?.[1];
    if (!value) fail(`.github/workflows/ci.yml: ${key} is read by the API but not pinned in the workflow env`);
    else if (!hostOf(value).endsWith(".invalid")) fail(`.github/workflows/ci.yml: ${key} must use a .invalid host, found ${hostOf(value) || value}`);
  }
  notes.push(`outbound URL variables pinned in CI: ${outbound.join(", ")}`);
}

// Production hosts reviewed as code or template defaults. Production sets each of these
// explicitly (verified 2026-10-18); staging and CI must set them too.
const reviewedProductionDefaults = new Set(["digiconomy-digipedia-production.up.railway.app", "x.getlifeos.app"]);

// 4. Production hosts used as API config defaults: reviewed list only.
{
  const config = read("apps/ecommerceos-api/src/config.ts");
  for (const m of config.matchAll(/process\.env\.([A-Z0-9_]+)\s*\?\?\s*"([^"]+)"/g)) {
    const host = hostOf(m[2]);
    if (!host || !PRODUCTION_HOST.test(host)) continue;
    if (reviewedProductionDefaults.has(host)) notes.push(`reviewed production default: ${m[1]} -> ${host} (must be set explicitly outside production)`);
    else fail(`apps/ecommerceos-api/src/config.ts: new production default ${m[1]} -> ${host}; remove it or review it`);
  }
}

// 5. Committed environment files.
{
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => /(^|\/)\.env(\.|$)/.test(f));
  for (const file of files) {
    if (!/\.env\.example$/.test(file)) {
      fail(`${file}: environment files must not be committed`);
      continue;
    }
    for (const line of read(file).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const value = raw.trim();
      if (value === "") continue;
      if (/_URL$/.test(key)) {
        const host = hostOf(value);
        if (/^file:/.test(value) || /^(localhost|127\.0\.0\.1)$/.test(host) || host.endsWith(".invalid")) continue;
        if (reviewedProductionDefaults.has(host)) notes.push(`${file}: ${key} template uses reviewed production host ${host}`);
        else fail(`${file}: ${key} must be empty, local or .invalid in a template, found ${host || "a non-URL value"}`);
      } else if (/(SECRET|TOKEN|KEY|PASSWORD)$/.test(key) && !/^dev[-_]|change-me|example/i.test(value)) {
        fail(`${file}: ${key} must be empty or an obvious dev placeholder in a template`);
      }
    }
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("environment isolation checks passed");
