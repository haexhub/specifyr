import { defineStore } from "pinia";

export type ProviderName = "anthropic" | "openai" | "google" | "openrouter";

export type ProviderIdentity = {
  id: string;
  label: string;
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
};

type State = {
  identities: ProviderIdentity[];
  activeIdentityId: string | null;
};

function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for ancient environments — never hit in browsers or
  // happy-dom, but keeps the store import-safe in odd test envs.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const useProviderIdentityStore = defineStore("speckit-provider-identity", {
  state: (): State => ({
    identities: [],
    activeIdentityId: null,
  }),

  getters: {
    active(state): ProviderIdentity | null {
      if (!state.activeIdentityId) return null;
      return (
        state.identities.find((i) => i.id === state.activeIdentityId) ?? null
      );
    },
  },

  actions: {
    add(identity: Omit<ProviderIdentity, "id">): string {
      const id = newId();
      this.identities.push({ ...identity, id });
      return id;
    },

    update(id: string, patch: Partial<ProviderIdentity>): void {
      const idx = this.identities.findIndex((i) => i.id === id);
      if (idx === -1) return;
      const current = this.identities[idx]!;
      // Pull `id` off the patch so callers can't rewrite it.
      const { id: _ignored, ...rest } = patch;
      this.identities[idx] = { ...current, ...rest };
    },

    remove(id: string): void {
      const idx = this.identities.findIndex((i) => i.id === id);
      if (idx === -1) return;
      this.identities.splice(idx, 1);
      if (this.activeIdentityId === id) {
        this.activeIdentityId = null;
      }
    },

    setActive(id: string | null): void {
      this.activeIdentityId = id;
    },
  },

  persist: {
    pick: ["identities", "activeIdentityId"],
  },
});
