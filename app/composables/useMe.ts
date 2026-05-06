interface Me {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

/**
 * Shared accessor for the authenticated user. Wraps useFetch with a stable
 * key so concurrent callers (sidebar, settings page, dropdowns) hit one
 * request. Returns `me: null` when not authenticated — components decide
 * whether to render fallback.
 *
 * The logout URL routes through Authentik's default invalidation flow,
 * which clears the .haex.cloud session cookie. Forward-auth then
 * intercepts the next protected request and bounces the user to login.
 */
export function useMe() {
  const config = useRuntimeConfig();
  const { data: me, refresh } = useFetch<Me | null>("/api/me", {
    default: () => null,
    key: "me",
    // Don't blow up the page on 401 — settings UI handles the empty state.
    onResponseError(ctx) {
      if (ctx.response.status === 401 || ctx.response.status === 503) {
        ctx.response._data = null;
      }
    },
  });

  const logoutUrl = computed(() => {
    const authHost = config.public.authHost as string | undefined;
    if (!authHost) {
      return "#";
    }
    const next =
      typeof window !== "undefined"
        ? encodeURIComponent(window.location.origin + "/")
        : "";
    return `${authHost}/if/flow/default-invalidation-flow/?next=${next}`;
  });

  return { me, refresh, logoutUrl };
}
