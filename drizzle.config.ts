import { defineConfig } from "drizzle-kit";

// drizzle-kit reads this for schema-diff and migration generation.
// Local workflow:
//   1. edit server/db/schema.ts
//   2. pnpm drizzle-kit generate    -> writes server/db/migrations/<n>_<name>.sql
//   3. server/plugins/db.ts applies pending migrations on next boot
export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Only needed for `drizzle-kit push` / `drizzle-kit studio` against a
    // live DB. Migrations themselves run via the migrator at boot, which
    // doesn't read this config.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/specifyr",
  },
});
