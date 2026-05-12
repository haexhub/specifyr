import { eq, sql } from "drizzle-orm";
import { getDb } from "../database/client";
import { users } from "../database/schema";
import {
  SETTING_KEYS,
  getSetting,
  type RegistrationPolicy,
} from "../utils/platform-settings";

declare module "h3" {
  interface H3EventContext {
    /** Set when the request is authenticated AND the DB is configured. */
    userId?: string;
    userEmail?: string;
  }
}

/**
 * Auth middleware. Reads the trusted forward-auth headers Authelia
 * injects on authenticated requests (`Remote-Email`, `Remote-Name`),
 * UPSERTs a `users` row keyed on email, and attaches the user id to
 * `event.context.userId` for downstream handlers.
 *
 * Behaviour matrix:
 *   - DB unconfigured (DATABASE_URL empty)   → no-op, downstream stays
 *     in legacy single-user mode.
 *   - DB configured, no Remote-Email header  → no-op. The route layer
 *     is responsible for 401-ing if it requires auth.
 *   - DB configured, header present          → UPSERT, set context.
 *
 * Local-dev override: setting `SPECIFYR_DEV_USER_EMAIL` in the env
 * synthesises a Remote-Email header so devs can run without Authelia.
 * Production deploys MUST NOT set this env var.
 */
export default defineEventHandler(async (event) => {
  const db = getDb();
  if (!db) return;

  // Authentik's proxy outpost forwards X-authentik-email / X-authentik-name.
  // Authelia's forward-auth forwards Remote-Email / Remote-Name.
  // Read both so a deploy can swap IDPs without code changes; specific
  // provider's headers win when both are present (shouldn't happen).
  const headerEmail = (
    getHeader(event, "x-authentik-email") ||
    getHeader(event, "remote-email") ||
    ""
  )
    .trim()
    .toLowerCase();

  // Dev-mode logout: when SPECIFYR_DEV_USER_EMAIL is set, the env-var
  // would otherwise auto-login the dev user on every request. The
  // `specifyr-dev-loggedout` cookie suppresses that fallback so the
  // Logout button is testable without spinning up Authentik locally.
  const devLoggedOut = getCookie(event, "specifyr-dev-loggedout") === "1";
  const devEmail = devLoggedOut
    ? undefined
    : process.env.SPECIFYR_DEV_USER_EMAIL?.trim().toLowerCase();

  const email = headerEmail || devEmail;
  if (!email) return;

  const displayName =
    getHeader(event, "x-authentik-name")?.trim() ||
    getHeader(event, "remote-name")?.trim() ||
    getHeader(event, "x-authentik-username")?.trim() ||
    getHeader(event, "remote-user")?.trim() ||
    null;

  // Platform-admin flag is derived from the env list on every upsert.
  // Storing it on the row (vs re-checking the env on every request)
  // keeps later platform-admin gating cheap and lets future UI surface
  // the flag without an env-var round-trip. Comma- or space-separated.
  const adminEmails = (process.env.SPECIFYR_PLATFORM_ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isPlatformAdmin = adminEmails.includes(email);

  // Self-registration policy gate. We check before insert because the
  // policy decision depends on whether the user already exists — we
  // never block existing logins, only first-time creation. Platform
  // admins bypass the gate so an admin email rotation can't lock out
  // the rest of the team. Invite-acceptance routes also bypass: an
  // org-admin can onboard external collaborators even when the
  // platform is "closed". The token check on the accept endpoint
  // remains the authoritative gate for that path.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const path = event.path ?? event.node.req.url ?? "";
  const isInviteFlow = /^\/(api\/)?invites\//.test(path);

  if (!existing && !isPlatformAdmin && !isInviteFlow) {
    const policy = await getSetting<RegistrationPolicy>(
      SETTING_KEYS.registrationPolicy,
      "open",
    );
    if (policy === "closed") {
      throw createError({
        statusCode: 403,
        statusMessage:
          "Self-registration is disabled. Ask an admin for an invite.",
      });
    }
    if (policy === "domain") {
      const allowed = await getSetting<string[]>(
        SETTING_KEYS.registrationAllowedDomains,
        [],
      );
      const at = email.lastIndexOf("@");
      const domain = at >= 0 ? email.slice(at + 1) : "";
      if (!domain || !allowed.includes(domain)) {
        throw createError({
          statusCode: 403,
          statusMessage:
            "Email domain not permitted. Ask an admin for an invite.",
        });
      }
    }
  }

  // UPSERT — insert if new, update display_name + updated_at on conflict.
  // We don't trust client to lower-case email, so we lower it ourselves
  // (Authentik already does, but devs/curl might not).
  //
  // No auto-org creation here — mandatory-org model leaves new users
  // with `memberships.length === 0` so the UI's onboarding gate forces
  // them through `/onboarding/create-org` before they can do anything.
  const [row] = await db
    .insert(users)
    .values({ email, displayName, isPlatformAdmin })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        displayName,
        isPlatformAdmin,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: users.id });

  if (!row) return;

  event.context.userId = row.id;
  event.context.userEmail = email;
});
