ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_unique";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_org_slug_uq" UNIQUE("owner_org_id","slug");