import { config } from "./config.js";
import { buildApp } from "./app.js";

export { buildApp } from "./app.js";

async function start() {
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ECommerceOS API listening on http://${config.host}:${config.port}`);
  return app;
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
