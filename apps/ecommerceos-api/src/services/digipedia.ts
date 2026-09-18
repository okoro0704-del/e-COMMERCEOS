import { config } from "../config.js";
import { prisma } from "../db.js";
import { httpError } from "../lib/crypto.js";
import type { MerchantAuth } from "../lib/auth.js";

export async function authorizedBusinessSlug(auth: MerchantAuth): Promise<string> {
  const store = await prisma.storeConfig.findUnique({ where: { tenantId: auth.tenantId } });
  const slug = store?.subdomain?.trim().toLowerCase();
  if (!slug) {
    throw httpError(400, "missing_slug", "This store needs a public address before DigiPedia can be maintained.");
  }
  return slug;
}

export async function callDigiPediaManage(input: {
  slug: string;
  actorId: string;
  method: string;
  suffix?: string;
  body?: unknown;
  accept?: string;
}) {
  if (!config.digipediaManageKey) {
    throw httpError(503, "digipedia_unconfigured", "DigiPedia authoring is not configured for this Admin.");
  }
  const url = `${config.digipediaUrl}/v1/manage/entries/${encodeURIComponent(input.slug)}${input.suffix ?? ""}`;
  const res = await fetch(url, {
    method: input.method,
    headers: {
      accept: input.accept ?? "application/json",
      "content-type": "application/json",
      "x-digipedia-manage-key": config.digipediaManageKey,
      "x-digipedia-actor": input.actorId,
      "x-digipedia-origin": "ecommerceos",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  if (input.accept === "text/html") {
    if (!res.ok) {
      throw httpError(res.status, "preview_failed", "Preview is not available.");
    }
    return { status: res.status, html: await res.text() };
  }
  const json = await res.json().catch(() => ({ error: "invalid", message: "DigiPedia did not return JSON." }));
  if (!res.ok) {
    const payload = json as { error?: string; message?: string };
    throw httpError(res.status, payload.error || "digipedia_error", payload.message || "DigiPedia request failed.");
  }
  return { status: res.status, json };
}
