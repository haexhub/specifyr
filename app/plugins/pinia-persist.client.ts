import piniaPluginPersistedstate from "pinia-plugin-persistedstate";

export default defineNuxtPlugin((nuxtApp) => {
  const pinia = nuxtApp.$pinia as ReturnType<typeof import("pinia").createPinia>;
  pinia.use(piniaPluginPersistedstate);
});
