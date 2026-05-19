CREATE TABLE "spec_draft_files" (
	"draft_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "spec_draft_files_draft_id_name_pk" PRIMARY KEY("draft_id","name")
);
--> statement-breakpoint
CREATE TABLE "spec_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_version" integer NOT NULL,
	"conversation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "spec_public_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_draft_files" ADD CONSTRAINT "spec_draft_files_draft_id_spec_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."spec_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_drafts" ADD CONSTRAINT "spec_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_drafts" ADD CONSTRAINT "spec_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_drafts_project_owner_idx" ON "spec_drafts" USING btree ("project_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "spec_drafts_project_status_idx" ON "spec_drafts" USING btree ("project_id","status");