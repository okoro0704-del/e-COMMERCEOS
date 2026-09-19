import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listLifeOsPublicFeed, streamPublicMediaAsset } from "../services/lifeos-public-feed.js";
import { getPublicBusinessPublication } from "../services/business-publications.js";

/**
 * Unauthenticated LifeOS discovery surfaces.
 * No management credentials. Active+public items only.
 */
export async function registerLifeOsPublicRoutes(app: FastifyInstance) {
  app.get("/v1/public/lifeos/feed", async (req) => {
    const query = z
      .object({
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        kind: z.enum(["product", "publication", "all"]).optional(),
      })
      .parse(req.query ?? {});
    return listLifeOsPublicFeed(query);
  });

  app.get("/v1/public/publications/:id", async (req, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const row = await getPublicBusinessPublication(params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return row;
  });

  app.get("/v1/public/media/:assetId", async (req, reply) => {
    const params = z.object({ assetId: z.string().min(1) }).parse(req.params);
    const media = await streamPublicMediaAsset(params.assetId);
    if (!media) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("Content-Type", media.contentType)
      .header("Cache-Control", "public, max-age=300")
      .send(Buffer.from(media.body));
  });
}
