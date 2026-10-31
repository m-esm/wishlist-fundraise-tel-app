import { afterAll } from "bun:test";
import type { DB } from "../db/client";
import * as schema from "../db/schema";

export async function testDb(): Promise<DB> {
  const migrationsFolder = new URL("../db/migrations", import.meta.url).pathname;
  if (process.env.TEST_DATABASE_URL) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const admin = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin`create database ${admin(name)}`;
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const client = postgres(url.toString(), { max: 1 });
    afterAll(async () => {
      await client.end();
      await admin`drop database ${admin(name)}`;
      await admin.end();
    });
    const db = drizzle(client, { schema, casing: "snake_case" });
    await migrate(db, { migrationsFolder });
    return db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite(), { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder });
  // Services are typed against the postgres-js driver; the query API is the same.
  return db as unknown as DB;
}
