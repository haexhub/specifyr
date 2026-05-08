/**
 * Route middleware that gates `/admin/*` to platform admins only.
 * Used as a named middleware (definePageMeta({ middleware: ["platform-admin"] }))
 * so pages outside /admin don't pay the cost of fetching `me`.
 *
 * Renders a redirect to `/` for non-admins. The server endpoints
 * under /api/admin/* enforce the same gate independently — this
 * client-side check is just UX so users don't see a 403 page after
 * clicking around.
 */
export default defineNuxtRouteMiddleware(() => {
  const { me } = useMe();
  if (!me.value || !me.value.isPlatformAdmin) {
    return navigateTo("/");
  }
});
