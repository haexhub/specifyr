import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { platformSettings } from "../db/schema";

/**
 * Platform-wide settings (key/value JSONB). Read at module-boundaries
 * (auth middleware checking registration policy, admin UI rendering
 * current state) and written by admin UI's PATCH endpoint.
 *
 * No in-memory cache — reads are infrequent enough (registration
 * happens at user-creation time, not per-request) that the index hit
 * on the PK is fine. If we ever shift to per-request reads we can
 * revisit with a lru-cache wrapper.
 */

export type RegistrationPolicy = "open" | "domain" | "closed";

/**
 * Known setting keys. JSONB lets us evolve the value shape without
 * schema changes — but listing the keys here keeps callers honest
 * about what's stored.
 */
export const SETTING_KEYS = {
  registrationPolicy: "registration.policy",
  registrationAllowedDomains: "registration.allowed_domains",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/**
 * Maps each setting key to its concrete value type. Single source of
 * truth — `getSetting`/`setSetting` infer their generics from this so
 * callers can't pair a key with a mismatched value shape.
 */
export type SettingValueByKey = {
  [SETTING_KEYS.registrationPolicy]: RegistrationPolicy;
  [SETTING_KEYS.registrationAllowedDomains]: string[];
};

/**
 * Reads a single setting. `defaultValue` is returned when the row is
 * absent OR when the DB is unconfigured — so callers can write code
 * that reads "as if" all settings always have a value.
 */
export async function getSetting<K extends SettingKey>(
  key: K,
  defaultValue: SettingValueByKey[K],
): Promise<SettingValueByKey[K]> {
  const db = getDb();
  if (!db) return defaultValue;
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);
  if (!row) return defaultValue;
  return row.value as SettingValueByKey[K];
}

/**
 * Reads multiple settings in one query. Returns a map keyed by the
 * setting key; missing keys are absent (caller fills with defaults).
 */
export async function getSettings<K extends SettingKey>(
  keys: K[],
): Promise<Partial<Pick<SettingValueByKey, K>>> {
  const db = getDb();
  if (!db || keys.length === 0) return {};
  const rows = await db
    .select()
    .from(platformSettings)
    .where(inArray(platformSettings.key, keys));
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<
    Pick<SettingValueByKey, K>
  >;
}

/**
 * Upserts a setting. `updatedByUserId` is recorded for audit so the
 * admin UI can render "last changed by X at Y".
 */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValueByKey[K],
  updatedByUserId: string,
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");
  await db
    .insert(platformSettings)
    .values({ key, value, updatedByUserId })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, updatedByUserId, updatedAt: new Date() },
    });
}
