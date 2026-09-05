import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL ?? "";
const schema = url.startsWith("postgres")
  ? path.join(apiRoot, "prisma/schema.postgresql.prisma")
  : path.join(apiRoot, "prisma/schema.prisma");

const result = spawnSync("npx", ["prisma", ...process.argv.slice(2), "--schema", schema], {
  cwd: apiRoot,
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
