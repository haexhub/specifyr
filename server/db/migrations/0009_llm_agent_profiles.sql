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
ALTER TABLE "llm_agent_profiles" ADD CONSTRAINT "llm_agent_profiles_credential_id_llm_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."llm_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_agent_profiles_owner_purpose_role_idx" ON "llm_agent_profiles" USING btree ("owner_kind","owner_id","purpose","agent_role");