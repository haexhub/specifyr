/**
 * Mandatory-org gate. Two symmetric redirects, both gated on the
 * caller's `memberships.length`:
 *
 *   - User with 0 memberships, NOT on /onboarding → /onboarding/create-org.
 *     Without this they could click around the app but every
 *     project-creating action would 400 with "create or join an
 *     organization first".
 *   - User with ≥1 memberships, ON /onboarding/* → /. Onboarding is
 *     a one-shot funnel; manually navigating back to it after creating
 *     an org would otherwise show a dead-end form.
 *
 * Skipped: /invites/*. Accepting an invite creates the first
 * membership, which clears the gate naturally; intercepting it here
 * would race with the accept POST.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith("/invites")) return;

  const { me } = useMe();
  // Unauthenticated users hit Authentik first; this gate doesn't
  // apply to them.
  if (!me.value) return;

  const hasMemberships = me.value.memberships.length > 0;
  const onOnboarding = to.path.startsWith("/onboarding");

  if (!hasMemberships && !onOnboarding) {
    return navigateTo("/onboarding/create-org");
  }
  if (hasMemberships && onOnboarding) {
    return navigateTo("/");
  }
});
