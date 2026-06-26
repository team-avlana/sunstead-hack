import { create } from 'zustand'

export type CommsStatus = 'idle' | 'connected' | 'reconnecting' | 'mock'

/** Canvas load lifecycle for the current project, drives the loading/error veil.
 *  - loading: fetching artifacts (or local XML) — the breathing orb.
 *  - ok: rendered (may be empty — that's a separate empty-state hint).
 *  - unreachable: the backend couldn't be reached — show "retry" (auto-recovers).
 *  - notfound: the project genuinely doesn't exist (404) — offer "Go home". */
export type LoadState = 'loading' | 'ok' | 'unreachable' | 'notfound'

/** Which screen the app is showing. Every canvas is tied to one project. */
export type View = 'home' | 'canvas'

/** The right-side panel's agent. 'agent' is our own Claude Agent SDK assistant;
 *  'claude' hosts the user's own Claude Code CLI in a PTY (the current default
 *  while the self-built agent stays hidden — see SHOW_SELF_BUILT_AGENT). */
export type RightPanel = 'agent' | 'claude'

interface RainyState {
  view: View
  currentProjectId: string | null
  currentProjectTitle: string
  commsStatus: CommsStatus
  /** Canvas load lifecycle for the open project (loading/ok/unreachable/notfound). */
  loadState: LoadState
  /** Number of canvas edits that failed to persist and are still retrying — drives
   *  the non-blocking "Changes not saved" chip so a flaky backend is never silent. */
  unsavedCount: number
  selectedIds: string[]
  sidebarCollapsed: boolean
  /** Right-side assistant panel open/closed (shared by both agent modes). */
  claudePanelOpen: boolean
  /** Which assistant the right panel runs: our agent or Claude Code (current default). */
  rightPanel: RightPanel
  /** Canvas dark mode — toggled from the bottom dock's sun button. */
  dark: boolean
  /** Open a project's canvas. Title is optional — the canvas load resolves it. */
  openProject: (id: string, title?: string) => void
  /** Back to the Home screen. */
  goHome: () => void
  setTitle: (title: string) => void
  setCommsStatus: (s: CommsStatus) => void
  setLoadState: (s: LoadState) => void
  /** Adjust the unsaved-writes counter (clamped at 0). +1 on a failed write, -1
   *  when a retry finally lands. */
  bumpUnsaved: (delta: number) => void
  setSelectedIds: (ids: string[]) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setClaudePanelOpen: (open: boolean) => void
  toggleClaudePanel: () => void
  /** Switch the right panel between our agent and the user's Claude Code. */
  setRightPanel: (panel: RightPanel) => void
  setDark: (dark: boolean) => void
  toggleDark: () => void
}

const DARK_KEY = 'rainy:dark'
const RIGHT_PANEL_KEY = 'rainy:rightPanel'

/** Read the persisted dark-mode preference (SSR-safe). */
function initialDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(DARK_KEY) === '1'
}

/** Read the persisted right-panel choice (SSR-safe). Defaults to Claude Code while
 *  our self-built agent stays hidden (see SHOW_SELF_BUILT_AGENT in RightPanel). */
function initialRightPanel(): RightPanel {
  if (typeof window === 'undefined') return 'claude'
  return window.localStorage.getItem(RIGHT_PANEL_KEY) === 'agent' ? 'agent' : 'claude'
}

/** App/UI + navigation state only. Canvas truth lives in the tldraw store, not here. */
export const useRainyStore = create<RainyState>((set) => ({
  view: 'home',
  currentProjectId: null,
  currentProjectTitle: '',
  commsStatus: 'idle',
  loadState: 'loading',
  unsavedCount: 0,
  selectedIds: [],
  sidebarCollapsed: false,
  claudePanelOpen: true,
  rightPanel: initialRightPanel(),
  dark: initialDark(),
  // Opening a project resets the load veil to "loading" (the canvas remounts and
  // re-fetches); clear any stale unsaved counter from the previous project.
  openProject: (id, title) =>
    set({ view: 'canvas', currentProjectId: id, currentProjectTitle: title ?? '', loadState: 'loading', unsavedCount: 0 }),
  goHome: () => set({ view: 'home', currentProjectId: null, loadState: 'loading', unsavedCount: 0 }),
  setTitle: (currentProjectTitle) => set({ currentProjectTitle }),
  setCommsStatus: (commsStatus) => set({ commsStatus }),
  setLoadState: (loadState) => set({ loadState }),
  bumpUnsaved: (delta) => set((s) => ({ unsavedCount: Math.max(0, s.unsavedCount + delta) })),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setClaudePanelOpen: (claudePanelOpen) => set({ claudePanelOpen }),
  toggleClaudePanel: () => set((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
  setRightPanel: (rightPanel) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(RIGHT_PANEL_KEY, rightPanel)
    set({ rightPanel })
  },
  setDark: (dark) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(DARK_KEY, dark ? '1' : '0')
    set({ dark })
  },
  toggleDark: () =>
    set((s) => {
      const dark = !s.dark
      if (typeof window !== 'undefined') window.localStorage.setItem(DARK_KEY, dark ? '1' : '0')
      return { dark }
    }),
}))
