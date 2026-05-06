import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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

// Tenant boundary. Created by any logged-in user; creator becomes
// admin automatically. `slug` is URL-safe, derived from `name`.
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;

export const orgMemberships = pgTable(
  "org_memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    userIdx: index("org_memberships_user_idx").on(t.userId),
  }),
);

export type OrgMembership = typeof orgMemberships.$inferSelect;
export type NewOrgMembership = typeof orgMemberships.$inferInsert;

// One-time invite tokens. Created by an org admin, redeemed by the
// recipient after they log in via Authelia. `email` is recorded for
// display only — the redemption uses the authenticated user's email,
// so a stolen link can't be redeemed by someone else (within reason —
// see the `revoked_at` lifecycle for compromise handling).
export const orgInvites = pgTable("org_invites", {
  token: text("token").primaryKey(),                  // random 32-byte hex
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  invitedEmail: text("invited_email").notNull(),
  invitedRole: text("invited_role", { enum: ["admin", "member"] }).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type OrgInvite = typeof orgInvites.$inferSelect;
export type NewOrgInvite = typeof orgInvites.$inferInsert;

// LLM provider credentials. Polymorphic owner: user-personal or
// org-shared (Phase 5 wires the org case into the runner). Encrypted
// fields use the same AES-256-GCM master key as secrets-store.ts —
// stored as hex strings (text), not bytea, so the schema stays
// portable to non-Postgres backends if we ever swap.
export const llmCredentials = pgTable(
  "llm_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerKind: text("owner_kind", { enum: ["user", "org"] }).notNull(),
    ownerId: uuid("owner_id").notNull(),

    provider: text("provider", {
      enum: ["anthropic", "openai", "google"],
    }).notNull(),
    mode: text("mode", { enum: ["api_key", "oauth_claude"] }).notNull(),
    displayName: text("display_name").notNull(),

    // api_key mode: encrypted blob. NULL when mode='oauth_claude' (Phase 8).
    apiKeyIv: text("api_key_iv"),
    apiKeyTag: text("api_key_tag"),
    apiKeyData: text("api_key_data"),

    // oauth_claude mode (Phase 8): tokens live in
    // <dataDir>/credentials/<owner_kind>/<owner_id>/.claude/credentials.json;
    // this row only tracks the high-level state.
    oauthStatus: text("oauth_status", {
      enum: ["pending", "authorized", "expired"],
    }),
    oauthAuthorizedAt: timestamp("oauth_authorized_at", { withTimezone: true }),

    baseUrl: text("base_url"),
    defaultModel: text("default_model"),
    enabled: boolean("enabled").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerIdx: index("llm_credentials_owner_idx").on(
      t.ownerKind,
      t.ownerId,
      t.provider,
      t.enabled,
    ),
    uniqueDisplayName: unique("llm_credentials_owner_provider_name_uq").on(
      t.ownerKind,
      t.ownerId,
      t.provider,
      t.displayName,
    ),
  }),
);

export type LlmCredential = typeof llmCredentials.$inferSelect;
export type NewLlmCredential = typeof llmCredentials.$inferInsert;
