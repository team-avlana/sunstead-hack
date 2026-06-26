import { wsBase } from './api'

/**
 * Client for the python-service dev activity bus (see python-service/dev_events.py).
 * Dev-only: gated by NEXT_PUBLIC_RAINY_DEV_PANEL at build time AND by the backend's
 * RAINY_DEV_LOGS at runtime — the websocket simply won't open if the backend half
 * is off, so the panel degrades to "disabled" rather than erroring.
 */

export type DevEventKind = 'span' | 'log'
/** span: 'start' | 'ok' | 'error'. log: a stdlib level name (INFO/WARNING/…). */
export type DevEventStatus = string

export interface DevEvent {
  id: number
  ts: number // epoch seconds
  kind: DevEventKind
  category: string // 'http' | 'analysis' | 'image' | 'agent' | log source …
  name: string
  status: DevEventStatus
  duration_ms: number | null
  detail: string | null
  span_id: number | null
}

type WsMessage =
  | { type: 'backlog'; events: DevEvent[] }
  | { type: 'event'; event: DevEvent }

/** True only when the panel was compiled in (frontend gate). */
export function devPanelEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_RAINY_DEV_PANEL
  return v === '1' || v === 'true'
}

export interface DevEventsHandlers {
  onBacklog: (events: DevEvent[]) => void
  onEvent: (event: DevEvent) => void
  onStatus: (s: 'connected' | 'reconnecting' | 'disabled') => void
}

/**
 * Connect to /dev/events with capped exponential-backoff reconnect. Returns a
 * cleanup function. A 1008 close (backend dev logs off) is treated as "disabled"
 * and we stop retrying — nothing to stream.
 */
export function connectDevEvents(h: DevEventsHandlers): () => void {
  if (typeof window === 'undefined' || !devPanelEnabled()) return () => {}

  let closed = false
  let ws: WebSocket | null = null
  let retry: number | undefined
  let attempt = 0
  const RETRY_BASE_MS = 1500
  const RETRY_MAX_MS = 20000

  const scheduleRetry = () => {
    if (closed) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
    attempt++
    h.onStatus('reconnecting')
    retry = window.setTimeout(open, delay)
  }

  function open() {
    const base = wsBase()
    if (!base || closed) return
    try {
      ws = new WebSocket(`${base}/dev/events`)
    } catch {
      scheduleRetry()
      return
    }
    ws.onopen = () => {
      attempt = 0
      h.onStatus('connected')
    }
    ws.onmessage = (ev) => {
      let msg: WsMessage
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (msg.type === 'backlog') h.onBacklog(msg.events)
      else if (msg.type === 'event') h.onEvent(msg.event)
    }
    ws.onclose = (ev) => {
      ws = null
      if (closed) return
      // 1008 = backend refused because RAINY_DEV_LOGS is off; don't hammer it.
      if (ev.code === 1008) {
        h.onStatus('disabled')
        return
      }
      scheduleRetry()
    }
    ws.onerror = () => {
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    }
  }

  open()

  return () => {
    closed = true
    window.clearTimeout(retry)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
  }
}

// ── derived view: collapse span start/end pairs into single rows ────────────────

export interface ActivityRow {
  key: string
  ts: number
  kind: DevEventKind
  category: string
  name: string
  /** 'running' | 'ok' | 'error' for spans; the level name for logs. */
  status: string
  durationMs: number | null
  detail: string | null
}

/**
 * Fold a raw event stream into display rows: a span's start+end (same span_id)
 * become one row (running until the end arrives), and each log is its own row.
 * Newest first.
 */
export function toActivityRows(events: DevEvent[]): ActivityRow[] {
  const spans = new Map<number, ActivityRow>()
  const logs: ActivityRow[] = []

  for (const e of events) {
    if (e.kind === 'span' && e.span_id != null) {
      const existing = spans.get(e.span_id)
      if (e.status === 'start') {
        if (!existing) {
          spans.set(e.span_id, {
            key: `s${e.span_id}`,
            ts: e.ts,
            kind: 'span',
            category: e.category,
            name: e.name,
            status: 'running',
            durationMs: null,
            detail: e.detail,
          })
        }
      } else {
        // end (ok | error): keep the start ts so ordering reflects when it began
        const base = existing ?? {
          key: `s${e.span_id}`,
          ts: e.ts,
          kind: 'span' as const,
          category: e.category,
          name: e.name,
          status: 'running',
          durationMs: null,
          detail: e.detail,
        }
        spans.set(e.span_id, {
          ...base,
          status: e.status,
          durationMs: e.duration_ms,
          detail: e.detail ?? base.detail,
        })
      }
    } else {
      logs.push({
        key: `l${e.id}`,
        ts: e.ts,
        kind: 'log',
        category: e.category,
        name: e.name,
        status: e.status,
        durationMs: null,
        detail: e.detail,
      })
    }
  }

  return [...spans.values(), ...logs].sort((a, b) => b.ts - a.ts)
}
