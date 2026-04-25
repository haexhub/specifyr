import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  devtools: { enabled: true },
  css: ["~/assets/css/tailwind.css"],
  components: [
    {
      path: "~/components",
      extensions: [".vue"]
    }
  ],
  modules: ["shadcn-nuxt"],
  vite: {
    plugins: [tailwindcss()]
  },
  shadcn: {
    prefix: "",
    componentDir: "./app/components/generated"
  },
  runtimeConfig: {
    public: {
      appName: "SpecOps"
    }
  }
});
