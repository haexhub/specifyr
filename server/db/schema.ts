import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Mirror of Authelia identity. UPSERT'd by the auth middleware on the
// first request from a previously-unseen email. `email` is the natural
// key — Authelia is the source of truth for who has what address.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Project ownership. `slug` matches the on-disk dir name (and the
// existing artifact-store key); we don't dual-source-of-truth — the
// filesystem stays the source for project content, this row only
// records who owns it.
//
// owner_kind/owner_id is polymorphic: points at users.id for personal
// projects, orgs.id for org-shared ones. No FK constraint because of
// the polymorphism (Postgres can't enforce it natively); integrity is
// checked at write-time in project-store.ts.
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    ownerKind: text("owner_kind", { enum: ["user", "org"] }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("projects_owner_idx").on(t.ownerKind, t.ownerId),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
