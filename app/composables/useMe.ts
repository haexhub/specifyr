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
 * `logout()` works in two modes:
 *   - production (authHost set): redirects to Authentik's default
 *     invalidation flow, which clears the .haex.cloud session cookie.
 *     Forward-auth then bounces the next protected request to login.
 *   - dev (authHost empty): POSTs /api/dev/logout, which sets a
 *     suppression cookie so the SPECIFYR_DEV_USER_EMAIL env-fallback
 *     stops auto-logging-in. Reload reflects the unauth state.
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

  const authHost = computed(
    () => (config.public.authHost as string | undefined) ?? "",
  );
  const isDevAuth = computed(() => !authHost.value);

  async function logout() {
    if (isDevAuth.value) {
      await $fetch("/api/dev/logout", { method: "POST" });
      // Reload so /api/me re-fetches and the auth middleware re-evaluates
      // with the suppression cookie now in place.
      if (typeof window !== "undefined") window.location.href = "/";
      return;
    }
    if (typeof window === "undefined") return;
    const next = encodeURIComponent(window.location.origin + "/");
    window.location.href = `${authHost.value}/if/flow/default-invalidation-flow/?next=${next}`;
  }

  async function devLogin() {
    if (!isDevAuth.value) return;
    await $fetch("/api/dev/login", { method: "POST" });
    if (typeof window !== "undefined") window.location.href = "/";
  }

  return { me, refresh, logout, devLogin, isDevAuth };
}
