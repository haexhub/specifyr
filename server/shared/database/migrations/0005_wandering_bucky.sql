CREATE SCHEMA "specifyr_vault";
--> statement-breakpoint
CREATE TABLE "specifyr_vault"."jwt_signing_key" (
	"kid" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"wrapped_private_key" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"kek_kid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "bridge_subnet" "cidr";--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "init_status" text DEFAULT 'pending_vault_init' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jwt_signing_key_one_active_uq" ON "specifyr_vault"."jwt_signing_key" USING btree ("active") WHERE "specifyr_vault"."jwt_signing_key"."active" = true;