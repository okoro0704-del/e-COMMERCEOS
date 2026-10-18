/**
 * Database for one e2e file. By default a throwaway SQLite file, as before. With
 * ECO_TEST_POSTGRES_URL set (CI), a fresh PostgreSQL database on that local server, named after
 * the file; `prisma db push` creates it with the PostgreSQL schema.
 */
export function testDatabaseUrl(sqliteUrl: string): string {
  const server = process.env.ECO_TEST_POSTGRES_URL;
  if (!server) return sqliteUrl;
  const url = new URL(server);
  // Test data is created and wiped freely: never against a shared or production server.
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("ECO_TEST_POSTGRES_URL must point at a local throwaway PostgreSQL server");
  }
  const name = sqliteUrl.replace(/^file:\.\//, "").replace(/\.db$/, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  url.pathname = `/eco_test_${name}`;
  return url.toString();
}

/** Extra `prisma db push` arguments for the database chosen by testDatabaseUrl. */
export function prismaSchemaArgs(): string {
  return process.env.ECO_TEST_POSTGRES_URL ? " --schema prisma/schema.postgresql.prisma" : "";
}
