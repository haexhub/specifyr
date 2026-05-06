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
	"base_url" text,
	"default_model" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_credentials_owner_provider_name_uq" UNIQUE("owner_kind","owner_id","provider","display_name")
);
--> statement-breakpoint
CREATE INDEX "llm_credentials_owner_idx" ON "llm_credentials" USING btree ("owner_kind","owner_id","provider","enabled");