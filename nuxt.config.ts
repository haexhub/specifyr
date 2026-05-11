import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  nitro: {
    alias: {
      "@su": fileURLToPath(new URL("./server/shared/utils", import.meta.url)),
    },
    typescript: {
      tsConfig: {
        compilerOptions: { paths: { "@su/*": ["../server/shared/utils/*"] } },
      },
    },
  },
  typescript: {
    tsConfig: {
      compilerOptions: { paths: { "@su/*": ["../server/shared/utils/*"] } },
    },
  },
  compatibilityDate: "2025-01-01",
  devtools: { enabled: true },
  css: ["~/assets/css/tailwind.css"],
  components: [
    {
      path: "~/components",
      extensions: [".vue"],
    },
  ],
  modules: ["shadcn-nuxt", "@nuxtjs/i18n"],
  vite: {
    plugins: [tailwindcss()],
  },
  shadcn: {
    prefix: "",
    componentDir: "./app/components/shadcn",
  },
  runtimeConfig: {
    companyClaudeProxyUrl: process.env.COMPANY_CLAUDE_PROXY_URL ?? "",
    companyOpsUrlBase:
      process.env.COMPANY_OPS_URL_BASE ?? "http://specifyr:3000/mcp",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? "",
    public: {
      appName: "specifyr",
      // Public so the Logout link can point at it. Set per-deployment
      // (in ansible's .env.j2 → AUTHENTIK_HOST). Empty string disables
      // the Logout link (dev mode w/o IDP).
      authHost: process.env.AUTHENTIK_HOST ?? "",
      // Truthy iff SPECIFYR_DEV_USER_EMAIL is set on the server. The
      // value itself stays server-side (display-only); we just need a
      // boolean so the UI can render the Sign-in (dev) button only when
      // it would actually do something.
      devAuthAvailable: !!process.env.SPECIFYR_DEV_USER_EMAIL,
    },
  },
  i18n: {
    locales: [{ code: "de", language: "de-DE", file: "de.json" }],
    defaultLocale: "de",
  },
});
