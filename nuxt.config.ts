import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  nitro: {
    alias: { "@su": fileURLToPath(new URL("./server/utils", import.meta.url)) }
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
    companyClaudeProxyUrl: process.env.COMPANY_CLAUDE_PROXY_URL ?? "",
    companyOpsUrlBase: process.env.COMPANY_OPS_URL_BASE ?? "http://specifyr:3000/mcp",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? "",
    public: {
      appName: "specifyr"
    }
  },
  i18n: {
    locales: [{ code: "de", language: "de-DE", file: "de.json" }],
    defaultLocale: "de",
    lazy: false
  }
});
