import { sql } from "drizzle-orm";
import type { getDb } from "../database/client";

type Db = NonNullable<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbHandle = Db | Tx;

// Stable numeric key for pg_advisory_xact_lock. Picked arbitrarily but
// kept in source so it's reproducible and grep-able. Fits int4 (signed
// 32-bit) so node-postgres passes it without BigInt gymnastics. Any
// process allocating a subnet must take this lock first; the lock
// auto-releases at transaction end.
const BRIDGE_ALLOCATOR_LOCK_KEY = 0x42_44_52_47; // 0x42445247 "BDRG"

const DEFAULT_POOL = "10.20.0.0/14";

export interface AllocatorOptions {
  /** CIDR pool to allocate /24s from. Falls back to SPECIFYR_BRIDGE_POOL env, then 10.20.0.0/14. */
  pool?: string;
}

/**
 * Allocates the next free `/24` from the configured pool. MUST be called
 * inside a transaction — uses `pg_advisory_xact_lock` to serialise
 * concurrent allocations across processes. The returned CIDR is NOT
 * inserted anywhere; the caller is responsible for using it in the same
 * transaction so commit acts as the reservation.
 *
 * Throws when the pool is exhausted or the configured pool is invalid.
 */
export async function allocateBridgeSubnet(
  tx: DbHandle,
  opts: AllocatorOptions = {},
): Promise<string> {
  const poolCidr =
    opts.pool ?? process.env.SPECIFYR_BRIDGE_POOL ?? DEFAULT_POOL;
  const { baseInt, prefix } = parseCidr(poolCidr);
  if (prefix > 24) {
    throw new Error(
      `bridge pool must be /24 or larger, got ${poolCidr} (prefix ${prefix})`,
    );
  }
  // Cast: the single-arg pg_advisory_xact_lock takes bigint. node-pg
  // passes JS numbers as int4 by default, which would overload-resolve
  // to the two-arg variant.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${BRIDGE_ALLOCATOR_LOCK_KEY}::bigint)`,
  );
  const rows = (await tx.execute(
    sql`SELECT bridge_subnet::text AS subnet FROM orgs WHERE bridge_subnet IS NOT NULL`,
  )) as unknown as { rows: Array<{ subnet: string }> };
  const used = new Set<string>(rows.rows.map((r) => r.subnet));
  const slotCount = 1 << (24 - prefix);
  for (let i = 0; i < slotCount; i++) {
    const subnetInt = baseInt + i * 256;
    const cidr = `${intToIp(subnetInt)}/24`;
    if (!used.has(cidr)) return cidr;
  }
  throw new Error(`bridge subnet pool ${poolCidr} exhausted`);
}

export function parseCidr(cidr: string): { baseInt: number; prefix: number } {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) throw new Error(`invalid CIDR: ${cidr}`);
  // The regex guarantees groups 1-5 exist; assert for TS's benefit.
  const [a, b, c, d] = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const prefix = Number(m[5]);
  if (
    [a, b, c, d].some((n) => n < 0 || n > 255) ||
    prefix < 0 ||
    prefix > 32
  ) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const raw = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefix === 0 ? 0 : ((~0 << (32 - prefix)) >>> 0);
  return { baseInt: (raw & mask) >>> 0, prefix };
}

export function intToIp(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}
