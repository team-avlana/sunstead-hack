import { create } from 'zustand'

export type CommsStatus = 'idle' | 'connected' | 'reconnecting' | 'mock'

interface RainyState {
  projectId: string
  commsStatus: CommsStatus
  selectedIds: string[]
  setCommsStatus: (s: CommsStatus) => void
  setSelectedIds: (ids: string[]) => void
}

/** App/UI state only. Canvas truth lives in the tldraw store, not here. */
export const useRainyStore = create<RainyState>((set) => ({
  projectId: 'default',
  commsStatus: 'idle',
  selectedIds: [],
  setCommsStatus: (commsStatus) => set({ commsStatus }),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
}))
