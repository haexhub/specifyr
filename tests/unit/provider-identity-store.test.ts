import { beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";

import {
  useProviderIdentityStore,
  type ProviderIdentity,
} from "../../app/stores/provider-identity";

/**
 * Build a fresh Pinia inside a throw-away Vue app. Pinia plugins (e.g.
 * persistedstate) are only attached to stores once `app.use(pinia)` has
 * fired — `setActivePinia(createPinia())` alone keeps them in the
 * `toBeInstalled` queue and they never run.
 */
function freshPinia() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  pinia.use(createPersistedState());
  app.use(pinia);
  setActivePinia(pinia);
  return pinia;
}

const sampleAnthropic: Omit<ProviderIdentity, "id"> = {
  label: "My Anthropic",
  provider: "anthropic",
  model: "claude-opus-4-7",
  apiKey: "sk-ant-xxxx",
};

const sampleOpenAI: Omit<ProviderIdentity, "id"> = {
  label: "Personal OpenAI",
  provider: "openai",
  model: "gpt-4o",
  apiKey: "sk-yyyy",
  baseUrl: "https://api.openai.com/v1",
};

describe("provider-identity store", () => {
  beforeEach(() => {
    localStorage.clear();
    freshPinia();
  });

  it("starts empty with no active identity", () => {
    const store = useProviderIdentityStore();
    expect(store.identities).toEqual([]);
    expect(store.activeIdentityId).toBeNull();
    expect(store.active).toBeNull();
  });

  it("add() returns a generated id and pushes the identity", () => {
    const store = useProviderIdentityStore();
    const id = store.add(sampleAnthropic);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(store.identities).toHaveLength(1);
    expect(store.identities[0]).toMatchObject({ ...sampleAnthropic, id });
  });

  it("add() generates a unique id per call", () => {
    const store = useProviderIdentityStore();
    const a = store.add(sampleAnthropic);
    const b = store.add(sampleOpenAI);
    expect(a).not.toBe(b);
    expect(store.identities).toHaveLength(2);
  });

  it("setActive() makes `active` return that identity", () => {
    const store = useProviderIdentityStore();
    const id = store.add(sampleAnthropic);
    store.setActive(id);
    expect(store.activeIdentityId).toBe(id);
    expect(store.active).toMatchObject({ id, ...sampleAnthropic });
  });

  it("setActive(unknown) normalises both active and activeIdentityId to null", () => {
    const store = useProviderIdentityStore();
    store.add(sampleAnthropic);
    store.setActive("not-a-real-id");
    // Both must agree — otherwise the UI ("an identity is active") and
    // the model resolver (sees null) drift apart.
    expect(store.active).toBeNull();
    expect(store.activeIdentityId).toBeNull();
  });

  it("remove(activeId) clears the active selection", () => {
    const store = useProviderIdentityStore();
    const id = store.add(sampleAnthropic);
    store.setActive(id);
    store.remove(id);
    expect(store.identities).toHaveLength(0);
    expect(store.activeIdentityId).toBeNull();
    expect(store.active).toBeNull();
  });

  it("remove(otherId) does not touch the active selection", () => {
    const store = useProviderIdentityStore();
    const activeId = store.add(sampleAnthropic);
    const otherId = store.add(sampleOpenAI);
    store.setActive(activeId);
    store.remove(otherId);
    expect(store.identities).toHaveLength(1);
    expect(store.activeIdentityId).toBe(activeId);
  });

  it("update() patches only the provided fields", () => {
    const store = useProviderIdentityStore();
    const id = store.add(sampleAnthropic);
    store.update(id, { label: "Renamed", model: "claude-sonnet-4-6" });
    const updated = store.identities[0]!;
    expect(updated.label).toBe("Renamed");
    expect(updated.model).toBe("claude-sonnet-4-6");
    expect(updated.provider).toBe("anthropic");
    expect(updated.apiKey).toBe(sampleAnthropic.apiKey);
  });

  it("update() does not change the id even if patch contains one", () => {
    const store = useProviderIdentityStore();
    const id = store.add(sampleAnthropic);
    store.update(id, { id: "spoofed-id" } as unknown as Partial<ProviderIdentity>);
    expect(store.identities[0]!.id).toBe(id);
  });

  it("update(unknown) is a no-op", () => {
    const store = useProviderIdentityStore();
    const id = store.add(sampleAnthropic);
    store.update("not-a-real-id", { label: "X" });
    expect(store.identities[0]!.label).toBe(sampleAnthropic.label);
    expect(store.identities).toHaveLength(1);
    // and didn't accidentally insert a new row
    expect(store.identities.map((i) => i.id)).toEqual([id]);
  });

  it("persists to localStorage and reloads in a fresh store instance", async () => {
    const store1 = useProviderIdentityStore();
    const id = store1.add(sampleAnthropic);
    store1.setActive(id);
    // pinia-plugin-persistedstate listens via `$subscribe` with the
    // default (post) flush, so the write to localStorage is queued and
    // only runs after Vue's tick scheduler flushes.
    await nextTick();

    // Tear down and start over with a brand new pinia instance —
    // simulates a tab reload.
    setActivePinia(undefined as never);
    freshPinia();

    const store2 = useProviderIdentityStore();
    expect(store2.identities).toHaveLength(1);
    expect(store2.identities[0]!.id).toBe(id);
    expect(store2.activeIdentityId).toBe(id);
    expect(store2.active).toMatchObject(sampleAnthropic);
  });
});
