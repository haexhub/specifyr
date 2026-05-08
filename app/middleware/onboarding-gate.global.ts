/**
 * Mandatory-org gate: an authenticated user without any org membership
 * is forced to /onboarding/create-org. Without this they could click
 * around the app but every project-creating action would 400 with
 * "create or join an organization first".
 *
 * Skipped paths:
 *   - /onboarding/* — the page that resolves the condition.
 *   - /invites/* — accepting an invite creates the first membership,
 *     which clears the gate naturally.
 *   - /api/* — server endpoints; this is a route middleware, not a
 *     server middleware, so technically those wouldn't hit anyway.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith("/onboarding")) return;
  if (to.path.startsWith("/invites")) return;

  const { me } = useMe();
  // Unauthenticated users hit Authentik first; this gate doesn't
  // apply to them.
  if (!me.value) return;
  if (me.value.memberships.length > 0) return;

  return navigateTo("/onboarding/create-org");
});
