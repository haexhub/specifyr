import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Mirror of Authentik identity. UPSERT'd by the auth middleware on the
// first request from a previously-unseen email. `email` is the natural
// key — Authentik is the source of truth for who has what address.
//
// `isPlatformAdmin` is populated from the `SPECIFYR_PLATFORM_ADMIN_EMAILS`
// env var on each upsert (see middleware/auth.ts). Storing it on the row
// rather than re-checking the env on every request keeps later
// platform-admin gating cheap and lets future UI surface "promote to
// platform admin" without an env-var round-trip.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Tenant boundary. Created by any logged-in user; creator becomes
// owner + admin automatically. `slug` is URL-safe, derived from `name`.
//
// `ownerUserId` is immutable except via the dedicated
// transfer-ownership endpoint, which atomically swaps it and ensures
// both old and new owners hold an admin membership row. Membership
// guards key off this column: the owner cannot be removed or demoted.
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;

// Project ownership. `slug` matches the on-disk dir name (and the
// existing artifact-store key); we don't dual-source-of-truth — the
// filesystem stays the source for project content, this row only
// records who owns it.
//
// Mandatory-org model: every project belongs to an org. Personal
// projects no longer exist as a first-class concept — a single-member
// org with the user as owner is the new "personal" workspace.
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    ownerOrgId: uuid("owner_org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerOrgIdx: index("projects_owner_org_idx").on(t.ownerOrgId),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

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
      // openrouter behaves as an OpenAI-compatible gateway in front of
      // many model families — single key, flexible model strings like
      // `anthropic/claude-sonnet-4-5`. base_url is the differentiator.
      enum: ["anthropic", "openai", "google", "openrouter"],
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

    // base_url: per-provider override or the gateway URL (openrouter
    // points at https://openrouter.ai/api/v1). Stored on the credential
    // because it's infrastructure metadata, not per-request choice.
    baseUrl: text("base_url"),
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

// Short-lived bearer tokens injected into agent containers in place of
// a real Anthropic API key. The haex-claude-proxy resolves the token
// against this table at request time, then spawns the `claude` CLI with
// HOME pointing at the matching credentials directory. The token itself
// carries no privilege beyond "this owner is allowed to use the proxy
// for this run" — short TTL keeps the blast radius small if a worker
// container is compromised.
//
// owner_kind/owner_id is polymorphic the same way as the rest of the
// schema (no FK on owner_id because of the polymorphism). user_id is
// the requesting user — recorded for auditability + so cascading delete
// of the user takes their sessions with them.
export const runnerSessions = pgTable(
  "runner_sessions",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ownerKind: text("owner_kind", { enum: ["user", "org"] }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("runner_sessions_user_idx").on(t.userId, t.expiresAt),
  }),
);

export type RunnerSession = typeof runnerSessions.$inferSelect;
export type NewRunnerSession = typeof runnerSessions.$inferInsert;

// Platform-level settings (one row per `key`). JSONB so each setting
// can carry its own shape — `registration.policy` is a string,
// `registration.allowed_domains` is a string[]. Validation lives in
// the helper layer (server/utils/platform-settings.ts), not the DB.
//
// Updating a setting always stamps `updated_by_user_id` for audit, so
// the platform-admin UI can render "last changed by X". `created_at`
// is implicit via the row's existence (no explicit column needed
// because settings are upserted, not appended).
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
});

export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;

// Per-org spec-kit extensions. Cloned from `source_url` into
// <dataDir>/extensions/orgs/<org_id>/<slug>/ — the FS path is reconstructable
// from the DB row, so we don't store it. `slug` comes from the cloned
// extension.yml's `extension.id`, NOT from user input — this prevents an
// attacker from registering a slug that shadows a bundled extension.
//
// Optional encrypted git credentials (HTTPS basic auth) for private repos:
// the same AES-256-GCM mechanism as secrets-store.ts. NULL credentials
// mean a public repo; partial NULLs are rejected at the store layer.
//
// Visibility: rows are scoped by `org_id` and never bleed across orgs;
// the resolver (server/utils/extension-install.ts) merges them on top of
// the deployment-global localExtensions and the bundled set when an
// owner-org context is known (project-create, project-detail).
export const orgExtensions = pgTable(
  "org_extensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceRef: text("source_ref"), // tag/branch/commit; null = default branch
    credentialUsername: text("credential_username"),
    credentialIv: text("credential_iv"),
    credentialTag: text("credential_tag"),
    credentialData: text("credential_data"),
    registeredBy: uuid("registered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqueSlugPerOrg: unique("org_extensions_org_slug_uq").on(t.orgId, t.slug),
    orgIdx: index("org_extensions_org_idx").on(t.orgId),
  }),
);

export type OrgExtension = typeof orgExtensions.$inferSelect;
export type NewOrgExtension = typeof orgExtensions.$inferInsert;

// Fine-grained, additive permissions on top of the admin/member role.
// A row grants one named permission to one user in one org; admins get
// every permission implicitly (the check in server/utils/org-permissions
// short-circuits on role='admin' before reading this table).
//
// `permission` is enumerated at the type AND DB level (CHECK constraint)
// so a typo can't drift past validation. New permissions extend the
// enum + a code path that uses them.
//
// Lifecycle: a delegated grant must vanish if the underlying membership
// vanishes — otherwise re-adding a previously-removed user resurrects
// their old `manage_extensions` privilege. The composite FK to
// `org_memberships(org_id, user_id)` with ON DELETE CASCADE makes
// membership the single source of authority. Deleting the org or user
// also cascades, transitively, via that membership row.
export const orgMemberPermissions = pgTable(
  "org_member_permissions",
  {
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    permission: text("permission", { enum: ["manage_extensions"] }).notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.permission] }),
    userIdx: index("org_member_permissions_user_idx").on(t.userId),
    membershipFk: foreignKey({
      name: "org_member_permissions_membership_fk",
      columns: [t.orgId, t.userId],
      foreignColumns: [orgMemberships.orgId, orgMemberships.userId],
    }).onDelete("cascade"),
    permissionCheck: check(
      "org_member_permissions_permission_chk",
      sql`${t.permission} IN ('manage_extensions')`,
    ),
  }),
);

export type OrgMemberPermission = typeof orgMemberPermissions.$inferSelect;
export type NewOrgMemberPermission = typeof orgMemberPermissions.$inferInsert;
