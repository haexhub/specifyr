-- Hand-written data backfill for the agent-vault Phase 1 rollout.
--
-- 0005 added `orgs.bridge_subnet` (cidr, nullable) and `orgs.init_status`
-- (text NOT NULL DEFAULT 'pending_vault_init'). Every pre-existing org
-- therefore now sits in 'pending_vault_init' and has no subnet — but
-- they were operational before this PR, so the agent-start guard would
-- refuse to spawn for them. This migration backfills both columns so
-- today's workflows keep working.
--
-- Idempotency: WHERE clauses scope the UPDATE to rows that still match
-- the post-0005 default state. Re-running on a DB where some orgs have
-- already been flipped (e.g. by a manual operator) is a no-op for those
-- rows.
--
-- Subnet allocation: deterministic offset within 10.20.0.0/14, ordered
-- by created_at to keep the mapping stable if the migration is replayed
-- against a clone of the same DB. The pool size (/14 = 1024 /24s) is
-- larger than any plausible existing-org count.

UPDATE orgs SET init_status = 'ready' WHERE init_status = 'pending_vault_init';
--> statement-breakpoint

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS rn
  FROM orgs
  WHERE bridge_subnet IS NULL
)
UPDATE orgs
SET bridge_subnet = set_masklen('10.20.0.0'::inet + (ranked.rn * 256), 24)::cidr
FROM ranked
WHERE orgs.id = ranked.id;
