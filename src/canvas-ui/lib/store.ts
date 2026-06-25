import { create } from 'zustand'

export type CommsStatus = 'idle' | 'connected' | 'reconnecting' | 'mock'

/** Which screen the app is showing. Every canvas is tied to one project. */
export type View = 'home' | 'canvas'

interface RainyState {
  view: View
  currentProjectId: string | null
  currentProjectTitle: string
  commsStatus: CommsStatus
  selectedIds: string[]
  sidebarCollapsed: boolean
  /** Right-side Claude Code panel (hosts the user's own `claude` CLI). */
  claudePanelOpen: boolean
  /** Canvas dark mode — toggled from the bottom dock's sun button. */
  dark: boolean
  /** Open a project's canvas. Title is optional — the canvas load resolves it. */
  openProject: (id: string, title?: string) => void
  /** Back to the Home screen. */
  goHome: () => void
  setTitle: (title: string) => void
  setCommsStatus: (s: CommsStatus) => void
  setSelectedIds: (ids: string[]) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setClaudePanelOpen: (open: boolean) => void
  toggleClaudePanel: () => void
  setDark: (dark: boolean) => void
  toggleDark: () => void
}

const DARK_KEY = 'rainy:dark'

/** Read the persisted dark-mode preference (SSR-safe). */
function initialDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(DARK_KEY) === '1'
}

/** App/UI + navigation state only. Canvas truth lives in the tldraw store, not here. */
export const useRainyStore = create<RainyState>((set) => ({
  view: 'home',
  currentProjectId: null,
  currentProjectTitle: '',
  commsStatus: 'idle',
  selectedIds: [],
  sidebarCollapsed: false,
  claudePanelOpen: true,
  dark: initialDark(),
  openProject: (id, title) => set({ view: 'canvas', currentProjectId: id, currentProjectTitle: title ?? '' }),
  goHome: () => set({ view: 'home', currentProjectId: null }),
  setTitle: (currentProjectTitle) => set({ currentProjectTitle }),
  setCommsStatus: (commsStatus) => set({ commsStatus }),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setClaudePanelOpen: (claudePanelOpen) => set({ claudePanelOpen }),
  toggleClaudePanel: () => set((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
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
