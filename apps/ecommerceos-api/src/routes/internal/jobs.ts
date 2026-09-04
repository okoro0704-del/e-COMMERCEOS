import type { FastifyInstance } from "fastify";
import { requireInternalToken } from "./provision.js";
import { sweepUnpaidOrders } from "../../services/orders.js";

export async function registerInternalJobRoutes(app: FastifyInstance) {
  app.post("/internal/jobs/sweep-unpaid-orders", async (req, reply) => {
    if (!requireInternalToken(req.headers.authorization)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Valid service bearer token required",
      });
    }
    const result = await sweepUnpaidOrders();
    return reply.send({ ok: true, ...result });
  });
}
