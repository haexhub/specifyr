<script setup lang="ts">
import { Building2, Gauge, Settings, Users } from "lucide-vue-next"
import { Tabs, TabsList, TabsTrigger } from "~/components/shadcn/tabs"

definePageMeta({ layout: "workspace", middleware: ["platform-admin"] })

const route = useRoute()
const currentTab = computed(() => {
  const p = route.path
  if (p.startsWith("/admin/users")) return "users"
  if (p.startsWith("/admin/orgs")) return "orgs"
  if (p.startsWith("/admin/settings")) return "settings"
  return "overview"
})
</script>

<template>
  <div class="mx-auto w-full max-w-7xl px-6 py-6">
    <Tabs :model-value="currentTab" class="mb-6">
      <TabsList>
        <TabsTrigger as-child value="overview">
          <NuxtLink to="/admin">
            <Gauge class="size-3.5" /> Overview
          </NuxtLink>
        </TabsTrigger>
        <TabsTrigger as-child value="users">
          <NuxtLink to="/admin/users">
            <Users class="size-3.5" /> Users
          </NuxtLink>
        </TabsTrigger>
        <TabsTrigger as-child value="orgs">
          <NuxtLink to="/admin/orgs">
            <Building2 class="size-3.5" /> Organizations
          </NuxtLink>
        </TabsTrigger>
        <TabsTrigger as-child value="settings">
          <NuxtLink to="/admin/settings/registration">
            <Settings class="size-3.5" /> Settings
          </NuxtLink>
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <NuxtPage />
  </div>
</template>
