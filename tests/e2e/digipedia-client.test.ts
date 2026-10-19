import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../../apps/ecommerceos-api/src/config.ts";
import { callDigiPediaManage } from "../../apps/ecommerceos-api/src/services/digipedia.ts";

test("EcommerceOS DigiPedia client targets the independent DigiPedia service", () => {
  assert.equal(config.digipediaUrl.includes("digipedia"), true);
  assert.doesNotMatch(config.digipediaUrl, /mybrandos/i);
});

test("EcommerceOS DigiPedia manage calls use ecommerceos origin and the server-chosen slug", async () => {
  if (!config.digipediaManageKey) {
    await assert.rejects(
      () =>
        callDigiPediaManage({
          slug: "mpa-6ppyad",
          actorId: "staff_1",
          method: "GET",
        }),
      (err: unknown) => Boolean(err && typeof err === "object" && (err as { statusCode?: number }).statusCode === 503),
    );
    return;
  }
  const originalFetch = globalThis.fetch;
  let seen: { url: string; headers: Headers } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen = { url, headers: new Headers(init?.headers) };
    return new Response(JSON.stringify({ intro: "Public knowledge about your business.", entry: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await callDigiPediaManage({ slug: "mpa-6ppyad", actorId: "staff_1", method: "GET" });
    assert.ok(seen);
    assert.equal(seen!.url.endsWith("/v1/manage/entries/mpa-6ppyad"), true);
    assert.equal(seen!.headers.get("x-digipedia-origin"), "ecommerceos");
    assert.equal(seen!.headers.get("x-digipedia-actor"), "staff_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unreachable or failing DigiPedia is reported as temporarily unavailable, in plain words", async () => {
  const savedKey = config.digipediaManageKey;
  const originalFetch = globalThis.fetch;
  config.digipediaManageKey = "test-manage-key";
  try {
    for (const fake of [
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      (async () => new Response("upstream exploded", { status: 502 })) as typeof fetch,
    ]) {
      globalThis.fetch = fake;
      await assert.rejects(
        () => callDigiPediaManage({ slug: "mpa-6ppyad", actorId: "staff_1", method: "GET" }),
        (err: unknown) => {
          const e = err as { statusCode?: number; code?: string; message?: string };
          return e.statusCode === 503 && e.code === "digipedia_unavailable" && /temporarily unavailable/i.test(e.message ?? "");
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    config.digipediaManageKey = savedKey;
  }
});
