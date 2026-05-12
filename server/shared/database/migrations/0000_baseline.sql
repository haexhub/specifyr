CREATE TABLE "llm_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"agent_role" text DEFAULT '' NOT NULL,
	"runner_key" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_agent_profiles_owner_purpose_role_uq" UNIQUE("owner_kind","owner_id","purpose","agent_role")
);
--> statement-breakpoint
CREATE TABLE "llm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"display_name" text NOT NULL,
	"api_key_iv" text,
	"api_key_tag" text,
	"api_key_data" text,
	"oauth_status" text,
	"oauth_authorized_at" timestamp with time zone,
	"oauth_credentials_iv" text,
	"oauth_credentials_tag" text,
	"oauth_credentials_data" text,
	"oauth_expires_at" timestamp with time zone,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_credentials_owner_provider_name_uq" UNIQUE("owner_kind","owner_id","provider","display_name")
);
--> statement-breakpoint
ALTER TABLE "llm_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
CREATE TABLE "org_invites" (
	"token" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"invited_email" text NOT NULL,
	"invited_role" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_member_permissions" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_permissions_org_id_user_id_permission_pk" PRIMARY KEY("org_id","user_id","permission"),
	CONSTRAINT "org_member_permissions_permission_chk" CHECK ("org_member_permissions"."permission" IN ('manage_extensions'))
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "runner_sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "llm_agent_profiles" ADD CONSTRAINT "llm_agent_profiles_credential_id_llm_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."llm_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_extensions" ADD CONSTRAINT "org_extensions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_extensions" ADD CONSTRAINT "org_extensions_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_permissions" ADD CONSTRAINT "org_member_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_permissions" ADD CONSTRAINT "org_member_permissions_membership_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."org_memberships"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_org_id_orgs_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_sessions" ADD CONSTRAINT "runner_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_agent_profiles_owner_purpose_role_idx" ON "llm_agent_profiles" USING btree ("owner_kind","owner_id","purpose","agent_role");--> statement-breakpoint
CREATE INDEX "llm_credentials_owner_idx" ON "llm_credentials" USING btree ("owner_kind","owner_id","provider","enabled");--> statement-breakpoint
CREATE INDEX "org_extensions_org_idx" ON "org_extensions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_member_permissions_user_idx" ON "org_member_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_memberships_user_idx" ON "org_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_owner_org_idx" ON "projects" USING btree ("owner_org_id");--> statement-breakpoint
CREATE INDEX "runner_sessions_user_idx" ON "runner_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE POLICY "llm_credentials_proxy_owner_isolation" ON "llm_credentials" AS PERMISSIVE FOR ALL TO "haex_claude_proxy" USING ((owner_kind = current_setting('app.current_owner_kind', true) AND owner_id::text = current_setting('app.current_owner_id', true)));