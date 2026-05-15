/**
 * Applies the authenticated user's preferred locale to the i18n module
 * whenever it differs from the active one. Watches the shared `useMe`
 * cache so editing the language preference on /settings/me/profile
 * takes effect immediately, no reload required.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const { me } = useMe();
  const i18n = nuxtApp.$i18n as {
    locale: { value: string };
    locales: { value: Array<{ code: string }> };
    setLocale: (code: string) => Promise<void>;
  };

  watch(
    () => me.value?.preferredLocale,
    (preferred) => {
      if (!preferred) return;
      const available = i18n.locales.value.some((l) => l.code === preferred);
      if (!available) return;
      if (i18n.locale.value === preferred) return;
      void i18n.setLocale(preferred);
    },
    { immediate: true },
  );
});
