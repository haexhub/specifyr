CREATE TABLE "org_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"source_url" text NOT NULL,
	"source_ref" text,
	"credential_username" text,
	"credential_iv" text,
	"credential_tag" text,
	"credential_data" text,
	"registered_by" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_extensions_org_slug_uq" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "org_member_permissions" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_permissions_org_id_user_id_permission_pk" PRIMARY KEY("org_id","user_id","permission")
);
--> statement-breakpoint
ALTER TABLE "org_extensions" ADD CONSTRAINT "org_extensions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_extensions" ADD CONSTRAINT "org_extensions_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_permissions" ADD CONSTRAINT "org_member_permissions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_permissions" ADD CONSTRAINT "org_member_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_permissions" ADD CONSTRAINT "org_member_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_extensions_org_idx" ON "org_extensions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_member_permissions_user_idx" ON "org_member_permissions" USING btree ("user_id");