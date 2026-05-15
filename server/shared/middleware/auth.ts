import { eq, sql } from "drizzle-orm";
import { getDb } from "../database/client";
import { users } from "../database/schema";
import {
  SETTING_KEYS,
  getSetting,
  type RegistrationPolicy,
} from "../utils/platform-settings";

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

declare module "h3" {
  interface H3EventContext {
    /** Set when the request is authenticated AND the DB is configured. */
    userId?: string;
    userEmail?: string;
    /** Set by project-access middleware on /api/orgs/:orgSlug/projects[/:projSlug]/* routes. */
    orgId?: string;
    orgSlug?: string;
    /** "admin" or "member" — the caller's org role for this URL's org. */
    orgRole?: "admin" | "member";
    /** Set only when the URL also includes a project slug. */
    projectSlug?: string;
    projectId?: string;
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

  // Platform-admin flag is derived on every upsert from two sources:
  // - SPECIFYR_PLATFORM_ADMIN_EMAILS env var (bootstrap; survives DB
  //   wipes, can't be revoked via UI)
  // - platform.admin_emails setting (managed by admins via /admin/settings)
  // Union of the two — UI grants additive, env list is authoritative.
  const envAdminEmails = (process.env.SPECIFYR_PLATFORM_ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
  const dbAdminEmails = (
    await getSetting<string[]>(SETTING_KEYS.platformAdminEmails, [])
  ).map(normalizeEmail);
  const isPlatformAdmin =
    envAdminEmails.includes(email) || dbAdminEmails.includes(email);

  // Self-registration policy gate. We check before insert because the
  // policy decision depends on whether the user already exists — we
  // never block existing logins, only first-time creation. Platform
  // admins bypass the gate so an admin email rotation can't lock out
  // the rest of the team. Invite-acceptance routes also bypass: an
  // org-admin can onboard external collaborators even when the
  // platform is "closed". The token check on the accept endpoint
  // remains the authoritative gate for that path.
  const [existing] = await db
    .select({ id: users.id, blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Platform-admin block: existing user with blocked_at set cannot sign
  // in. We reject before the upsert so a blocked admin can't reset their
  // own display_name / isPlatformAdmin flag by hitting any endpoint.
  if (existing?.blockedAt) {
    throw createError({
      statusCode: 403,
      statusMessage: "Account is blocked. Contact a platform admin.",
    });
  }

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

  // UPSERT — insert if new; on conflict refresh isPlatformAdmin (env/UI
  // can grant/revoke between sessions) but leave display_name alone so a
  // user-edited value from /settings/me/profile isn't clobbered by the
  // IDP header on the next request.
  const [row] = await db
    .insert(users)
    .values({ email, displayName, isPlatformAdmin })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        isPlatformAdmin,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: users.id });

  if (!row) return;

  event.context.userId = row.id;
  event.context.userEmail = email;
});
