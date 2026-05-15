/**
 * Pulls (orgSlug, projSlug) from route.params and exposes the matching
 * API + route prefixes. Pages under /specs/[orgSlug]/[projSlug]/* should
 * call this instead of recomputing the prefixes themselves.
 *
 * Components don't use this — they're rendered outside the route layer
 * and need both slugs as props so callers can pass them through.
 */
export function useProjectContext() {
  const route = useRoute();

  const orgSlug = computed(() => route.params.orgSlug as string);
  const projSlug = computed(() => route.params.projSlug as string);

  const apiBase = computed(
    () => `/api/orgs/${orgSlug.value}/projects/${projSlug.value}`,
  );
  const routeBase = computed(
    () => `/specs/${orgSlug.value}/${projSlug.value}`,
  );

  const cacheKey = computed(
    () => `${orgSlug.value}-${projSlug.value}`,
  );

  return { orgSlug, projSlug, apiBase, routeBase, cacheKey };
}
