// Drizzle schema. Tables are added phase-by-phase per the plan in
// docs/plans/2026-05-06-llm-provider-settings.md.
//
// Phase 1 will introduce `users`. Phase 2 adds `projects`. Phase 3 adds
// `orgs` + `org_memberships`. Phase 4 adds `llm_credentials`. Phase 6
// adds `runner_sessions`.
//
// Keep this file as the single source of truth — drizzle-kit generates
// migrations from the diff between schema.ts and the latest applied
// migration. Do not hand-edit the generated SQL.

export {};
