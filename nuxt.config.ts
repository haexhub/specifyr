import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  nitro: {
    alias: { "#su": "./server/utils" }
  },
  compatibilityDate: "2025-01-01",
  devtools: { enabled: true },
  css: ["~/assets/css/tailwind.css"],
  components: [
    {
      path: "~/components",
      extensions: [".vue"]
    }
  ],
  modules: ["shadcn-nuxt", "@nuxtjs/i18n"],
  vite: {
    plugins: [tailwindcss()]
  },
  shadcn: {
    prefix: "",
    componentDir: "./app/components/generated"
  },
  runtimeConfig: {
    public: {
      appName: "speculoss"
    }
  },
  i18n: {
    locales: [{ code: "de", language: "de-DE", file: "de.json" }],
    defaultLocale: "de"
  }
});
