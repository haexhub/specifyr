-- Mandatory-org schema refactor (plan 2026-05-08).
-- DESTRUCTIVE: wipes all project / org / membership / invite data plus
-- llm_credentials and runner_sessions rows whose owner is about to
-- vanish. Without this, the NOT NULL ADD COLUMNs below fail on any DB
-- with existing rows. Per the deploy plan this is acceptable — prod
-- carries no production-valuable data yet, and operators are
-- instructed to drop+recreate the database before rolling out.
TRUNCATE TABLE "projects", "org_invites", "org_memberships", "orgs" CASCADE;--> statement-breakpoint
DELETE FROM "llm_credentials" WHERE "owner_kind" = 'org';--> statement-breakpoint
DELETE FROM "runner_sessions" WHERE "owner_kind" = 'org';--> statement-breakpoint
DROP INDEX "projects_owner_idx";--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "owner_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_platform_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_org_id_orgs_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_owner_org_idx" ON "projects" USING btree ("owner_org_id");--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "owner_kind";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "owner_id";