import { ref, provide, inject, type Ref, type InjectionKey } from "vue";

export interface SidebarState {
  open: Ref<boolean>;
  toggle: () => void;
  close: () => void;
  setOpen: (value: boolean) => void;
}

const PROJECT_LIST_KEY: InjectionKey<SidebarState> = Symbol("sidebar:projectList");
const PROJECT_STEP_KEY: InjectionKey<SidebarState> = Symbol("sidebar:projectStep");

function createState(): SidebarState {
  const open = ref(false);
  return {
    open,
    toggle: () => (open.value = !open.value),
    close: () => (open.value = false),
    setOpen: (value: boolean) => (open.value = value)
  };
}

export function provideProjectListSidebar(): SidebarState {
  const state = createState();
  provide(PROJECT_LIST_KEY, state);
  return state;
}

export function useProjectListSidebar(): SidebarState | null {
  return inject(PROJECT_LIST_KEY, null);
}

export function provideProjectStepSidebar(): SidebarState {
  const state = createState();
  provide(PROJECT_STEP_KEY, state);
  return state;
}

export function useProjectStepSidebar(): SidebarState | null {
  return inject(PROJECT_STEP_KEY, null);
}
