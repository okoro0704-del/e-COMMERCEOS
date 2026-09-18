import type { FastifyInstance, FastifyReply } from "fastify";
import { requireMerchant } from "../lib/auth.js";
import { authorizedBusinessSlug, callDigiPediaManage } from "../services/digipedia.js";

async function ctx(req: Parameters<typeof requireMerchant>[0], reply: FastifyReply) {
  const auth = await requireMerchant(req, reply);
  if (!auth) return null;
  const slug = await authorizedBusinessSlug(auth);
  return { auth, slug };
}

export async function registerDigiPediaRoutes(app: FastifyInstance) {
  app.get("/v1/admin/digipedia", async (req, reply) => {
    const session = await ctx(req, reply);
    if (!session) return;
    const result = await callDigiPediaManage({
      slug: session.slug,
      actorId: session.auth.staffId,
      method: "GET",
    });
    return result.json;
  });

  app.post("/v1/admin/digipedia/initialize", async (req, reply) => {
    const session = await ctx(req, reply);
    if (!session) return;
    const result = await callDigiPediaManage({
      slug: session.slug,
      actorId: session.auth.staffId,
      method: "POST",
      suffix: "/initialize",
    });
    return result.json;
  });

  app.put("/v1/admin/digipedia/draft", async (req, reply) => {
    const session = await ctx(req, reply);
    if (!session) return;
    const result = await callDigiPediaManage({
      slug: session.slug,
      actorId: session.auth.staffId,
      method: "PUT",
      suffix: "/draft",
      body: req.body,
    });
    return result.json;
  });

  app.get("/v1/admin/digipedia/preview", async (req, reply) => {
    const session = await ctx(req, reply);
    if (!session) return;
    const result = await callDigiPediaManage({
      slug: session.slug,
      actorId: session.auth.staffId,
      method: "GET",
      suffix: "/preview",
      accept: "text/html",
    });
    reply.header("cache-control", "private, no-store");
    reply.type("text/html; charset=utf-8");
    return reply.send(result.html);
  });

  app.post("/v1/admin/digipedia/publish", async (req, reply) => {
    const session = await ctx(req, reply);
    if (!session) return;
    const result = await callDigiPediaManage({
      slug: session.slug,
      actorId: session.auth.staffId,
      method: "POST",
      suffix: "/publish",
      body: req.body,
    });
    return result.json;
  });

  app.get("/v1/admin/digipedia/revisions", async (req, reply) => {
    const session = await ctx(req, reply);
    if (!session) return;
    const result = await callDigiPediaManage({
      slug: session.slug,
      actorId: session.auth.staffId,
      method: "GET",
      suffix: "/revisions",
    });
    return result.json;
  });
}
