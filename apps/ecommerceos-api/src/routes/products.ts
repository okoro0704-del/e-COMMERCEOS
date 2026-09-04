import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMerchant } from "../lib/auth.js";
import {
  createProduct,
  createVariant,
  getProduct,
  listCategories,
  listProducts,
  updateProduct,
  updateVariant,
  uploadProductImage,
} from "../services/catalog.js";

export async function registerProductRoutes(app: FastifyInstance) {
  app.get("/v1/categories", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return listCategories(auth.tenantId);
  });

  app.get("/v1/products", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const query = z
      .object({
        status: z.string().optional(),
        categoryId: z.string().optional(),
      })
      .parse(req.query);
    return listProducts(auth.tenantId, query);
  });

  app.get("/v1/products/:id", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return getProduct(auth.tenantId, id);
  });

  app.post("/v1/products", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const body = z
      .object({
        title: z.string().min(1),
        description: z.string().optional(),
        categoryId: z.string().optional(),
        images: z.array(z.string()).optional(),
        variants: z
          .array(
            z.object({
              sku: z.string().min(1),
              title: z.string().optional(),
              barcode: z.string().optional(),
              priceMinor: z.number().int().nonnegative(),
              inventoryCount: z.number().int().nonnegative().optional(),
              weightGrams: z.number().int().nonnegative().optional(),
              lengthCm: z.number().nonnegative().optional(),
              widthCm: z.number().nonnegative().optional(),
              heightCm: z.number().nonnegative().optional(),
              images: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .parse(req.body);
    const product = await createProduct({ tenantId: auth.tenantId, actorId: auth.staffId, ...body });
    return reply.code(201).send(product);
  });

  app.patch("/v1/products/:id", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        categoryId: z.string().nullable().optional(),
        status: z.string().optional(),
        images: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return updateProduct(auth.tenantId, id, body);
  });

  app.post("/v1/products/:id/variants", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        sku: z.string().min(1),
        title: z.string().optional(),
        barcode: z.string().optional(),
        priceMinor: z.number().int().nonnegative(),
        inventoryCount: z.number().int().nonnegative().optional(),
        weightGrams: z.number().int().nonnegative().optional(),
        lengthCm: z.number().nonnegative().optional(),
        widthCm: z.number().nonnegative().optional(),
        heightCm: z.number().nonnegative().optional(),
        images: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const variant = await createVariant(auth.tenantId, id, body);
    return reply.code(201).send(variant);
  });

  app.patch("/v1/variants/:id", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        title: z.string().optional(),
        barcode: z.string().nullable().optional(),
        priceMinor: z.number().int().nonnegative().optional(),
        weightGrams: z.number().int().nonnegative().optional(),
        lengthCm: z.number().nonnegative().optional(),
        widthCm: z.number().nonnegative().optional(),
        heightCm: z.number().nonnegative().optional(),
        status: z.string().optional(),
        images: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return updateVariant(auth.tenantId, id, body);
  });

  app.post("/v1/media/upload", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const body = z
      .object({
        filename: z.string().min(1),
        contentType: z.string().optional(),
        body: z.string().min(1),
        encoding: z.enum(["base64", "utf8"]).default("base64"),
        productId: z.string().optional(),
      })
      .parse(req.body);
    const bytes =
      body.encoding === "base64" ? Buffer.from(body.body, "base64") : Buffer.from(body.body, "utf8");
    const stored = await uploadProductImage({
      tenantId: auth.tenantId,
      productId: body.productId,
      filename: body.filename,
      body: new Uint8Array(bytes),
      contentType: body.contentType,
    });
    return reply.code(201).send(stored);
  });
}
