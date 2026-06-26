'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { wsBase } from '@/lib/api'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'

/**
 * The Agent panel — Rainey, our own assistant built on the Claude Agent SDK and
 * hosted by the python-service (the default right-panel experience). It drives
 * the same MCP tools the canvas exposes, so its work lands on the canvas via the
 * normal change-signal path. No Claude login required. See agent_bridge.py.
 *
 * Mirrors ClaudePanel's glass shell + GSAP collapse, but the body is a streaming
 * chat: assistant text renders token-by-token, with a calm motion layer that
 * always says what's happening — connecting, thinking, using a tool, writing.
 * Model is chosen per chat; changing it reconnects (the agent fixes its model
 * per session). Honors prefers-reduced-motion (see globals.css).
 */

// Models deployed in the Azure Foundry resource the service uses. Opus is not
// deployed there, so it's omitted — add it here if/when it's deployed.
const MODELS: { id: string; label: string }[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]
const MODEL_KEY = 'rainy:agentModel'

// What the agent is doing right now — drives the status line + micro-states.
type Phase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'writing'

type Entry =
  | { kind: 'user' | 'assistant' | 'thinking'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'error'; text: string }

interface ChatState {
  entries: Entry[]
  /** Index of the entry currently being streamed into (assistant/thinking), or -1. */
  live: number
  liveKind: 'assistant' | 'thinking' | null
  phase: Phase
  /** Index of the in-flight tool chip (shows a spinner), or -1. */
  activeTool: number
  /** Name of the in-flight tool, for the status line. */
  toolName: string | null
}

type Action =
  | { t: 'user'; text: string }
  | { t: 'delta'; kind: 'assistant' | 'thinking'; text: string }
  | { t: 'tool'; name: string }
  | { t: 'error'; text: string }
  | { t: 'turn_end' }

const INITIAL: ChatState = { entries: [], live: -1, liveKind: null, phase: 'idle', activeTool: -1, toolName: null }

function reduce(s: ChatState, a: Action): ChatState {
  switch (a.t) {
    case 'user':
      return { ...s, entries: [...s.entries, { kind: 'user', text: a.text }], live: -1, liveKind: null, phase: 'waiting', activeTool: -1, toolName: null }
    case 'delta': {
      const phase: Phase = a.kind === 'thinking' ? 'thinking' : 'writing'
      // Append into the live bubble if it matches; else open a new one.
      if (s.live >= 0 && s.liveKind === a.kind) {
        const entries = s.entries.slice()
        const cur = entries[s.live] as Extract<Entry, { text: string }>
        entries[s.live] = { kind: a.kind, text: cur.text + a.text }
        return { ...s, entries, phase, activeTool: -1, toolName: phase === 'writing' ? null : s.toolName }
      }
      const entries = [...s.entries, { kind: a.kind, text: a.text } as Entry]
      return { ...s, entries, live: entries.length - 1, liveKind: a.kind, phase, activeTool: -1, toolName: phase === 'writing' ? null : s.toolName }
    }
    case 'tool': {
      const entries = [...s.entries, { kind: 'tool', name: a.name } as Entry]
      return { ...s, entries, live: -1, liveKind: null, phase: 'tool', activeTool: entries.length - 1, toolName: a.name }
    }
    case 'error': {
      const entries = [...s.entries, { kind: 'error', text: a.text } as Entry]
      return { ...s, entries, live: -1, liveKind: null }
    }
    case 'turn_end':
      return { ...s, live: -1, liveKind: null, phase: 'idle', activeTool: -1, toolName: null }
    default:
      return s
  }
}

function initialModel(): string {
  if (typeof window === 'undefined') return MODELS[0].id
  const saved = window.localStorage.getItem(MODEL_KEY)
  return MODELS.some((m) => m.id === saved) ? (saved as string) : MODELS[0].id
}

export default function AgentPanel() {
  const ref = useRef<HTMLElement>(null)
  const open = useRainyStore((s) => s.claudePanelOpen)
  const toggle = useRainyStore((s) => s.toggleClaudePanel)

  const [model, setModel] = useState(initialModel)
  const [chat, dispatch] = useReducer(reduce, INITIAL)
  const [draft, setDraft] = useState('')
  const [connected, setConnected] = useState(false)
  // Whether the agent actually connected to our MCP server, and how many of its
  // tools loaded. Authoritative once the SDK's init message arrives (first turn).
  const [mcp, setMcp] = useState<{ status: 'connecting' | 'connected' | 'error'; tools: number }>({
    status: 'connecting',
    tools: 0,
  })

  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const busy = chat.phase !== 'idle'

  // ---- websocket lifecycle (re-runs when the model changes) ----------------
  useEffect(() => {
    const base = wsBase()
    if (!base) return
    let disposed = false
    let ws: WebSocket | null = null
    let reconnect: number | undefined

    const connect = () => {
      if (disposed) return
      try {
        ws = new WebSocket(`${base}/agent?model=${encodeURIComponent(model)}`)
      } catch {
        return scheduleReconnect()
      }
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        setMcp({ status: 'connecting', tools: 0 })
      }
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(ev.data as string)
        } catch {
          return
        }
        switch (msg.type) {
          case 'mcp':
            setMcp({
              status: (msg.status as 'connected' | 'error') ?? 'error',
              tools: Number(msg.tools ?? 0),
            })
            break
          // Token-level streaming. Per-block fallbacks ('assistant'/'thinking')
          // are treated as one big delta so either backend mode renders the same.
          case 'assistant_delta':
          case 'assistant':
            dispatch({ t: 'delta', kind: 'assistant', text: String(msg.text ?? '') })
            break
          case 'thinking_delta':
          case 'thinking':
            dispatch({ t: 'delta', kind: 'thinking', text: String(msg.text ?? '') })
            break
          case 'tool_use':
            dispatch({ t: 'tool', name: String(msg.name ?? 'tool') })
            break
          case 'error':
            dispatch({ t: 'error', text: String(msg.message ?? 'error') })
            break
          case 'turn_end':
            dispatch({ t: 'turn_end' })
            break
        }
      }
      ws.onclose = () => {
        wsRef.current = null
        setConnected(false)
        setMcp({ status: 'connecting', tools: 0 })
        dispatch({ t: 'turn_end' }) // release the composer if a turn was in flight
        if (!disposed) scheduleReconnect()
      }
      ws.onerror = () => {
        try {
          ws?.close()
        } catch {
          /* ignore */
        }
      }
    }
    const scheduleReconnect = () => {
      if (disposed) return
      window.clearTimeout(reconnect)
      reconnect = window.setTimeout(connect, 1800)
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(reconnect)
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }
  }, [model])

  // Keep the transcript pinned to the latest content as it streams in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  // Auto-grow the composer with its content.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }, [draft])

  const onModel = (id: string) => {
    if (id === model) return
    if (typeof window !== 'undefined') window.localStorage.setItem(MODEL_KEY, id)
    setModel(id) // re-runs the ws effect → reconnect with the new model
  }

  const send = () => {
    const text = draft.trim()
    const ws = wsRef.current
    if (!text || busy || !ws || ws.readyState !== WebSocket.OPEN) return
    dispatch({ t: 'user', text })
    ws.send(JSON.stringify({ type: 'user', text }))
    setDraft('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // ---- panel shell: intro + collapse (mirrors ClaudePanel) -----------------
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { x: 16, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
    })
    return () => ctx.revert()
  }, [])

  const firstRun = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const hideX = el.offsetWidth + 28
    gsap.to(el, {
      x: open ? 0 : hideX,
      autoAlpha: open ? 1 : 0,
      duration: 0.42,
      ease: open ? 'power3.out' : 'power3.in',
      overwrite: 'auto',
    })
  }, [open])

  const noBackend = !wsBase()
  const status = statusFor(chat.phase, chat.toolName, connected, noBackend)

  return (
    <>
      <aside className="rainy-claude" ref={ref}>
        <div className="cc">
          <div className="cc-head">
            <div className="cc-title">
              <RaineyMark />
              <span>Rainey</span>
            </div>
            <div className="cc-head-actions">
              <span className={`cc-mcp ${mcp.status}`} title={mcpTitle(mcp.status, mcp.tools, noBackend)}>
                <span className="cc-mcp-dot" />
                {mcp.status === 'connected' ? `MCP · ${mcp.tools}` : mcp.status === 'error' ? 'MCP off' : 'MCP'}
              </span>
              <select
                className="cc-model"
                value={model}
                onChange={(e) => onModel(e.target.value)}
                title="Model for this chat"
                aria-label="Model"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button type="button" className="cc-collapse" title="Hide Rainey" aria-label="Hide Rainey" onClick={toggle}>
                <PanelIcon size={18} />
              </button>
            </div>
          </div>

          <div className="cc-chat" ref={scrollRef}>
            {chat.entries.length === 0 && !noBackend && (
              <div className="cc-empty">Ask Rainey to research, ideate, script, or storyboard — work lands on the canvas.</div>
            )}
            {noBackend && (
              <div className="cc-empty">Rainey is not connected. Set NEXT_PUBLIC_RAINY_API_URL and start the python-service.</div>
            )}

            {chat.entries.map((e, i) => {
              if (e.kind === 'tool')
                return (
                  <div key={i} className={`cc-tool${i === chat.activeTool ? ' active' : ''}`}>
                    <ToolIcon /> {prettyTool(e.name)}
                    {i === chat.activeTool && <span className="cc-spin" aria-hidden />}
                  </div>
                )
              if (e.kind === 'thinking')
                return (
                  <div key={i} className={`cc-think${i === chat.live ? ' live' : ''}`}>
                    {e.text}
                  </div>
                )
              if (e.kind === 'error')
                return (
                  <div key={i} className="cc-err">
                    {e.text}
                  </div>
                )
              return (
                <div key={i} className={`cc-msg ${e.kind}`}>
                  {e.text}
                  {e.kind === 'assistant' && i === chat.live && chat.phase === 'writing' && <span className="cc-caret" aria-hidden />}
                </div>
              )
            })}
          </div>

          {/* Always-present status line: connecting / thinking / using a tool / writing. */}
          <div className={`cc-status${status ? ' show' : ''}`} aria-live="polite">
            {status && (
              <>
                <span className="cc-status-orb" data-phase={chat.phase} />
                <span className="cc-status-text">{status}</span>
              </>
            )}
          </div>

          <div className="cc-compose">
            <textarea
              ref={taRef}
              className="cc-input"
              rows={1}
              placeholder={busy ? 'Rainey is working…' : 'Message Rainey…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={noBackend}
            />
            <button
              type="button"
              className="cc-send"
              onClick={send}
              disabled={busy || !draft.trim() || noBackend}
              title="Send"
              aria-label="Send"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </aside>

      <button
        type="button"
        className={`rainy-claude-show${!open ? ' show' : ''}`}
        title="Show Rainey"
        aria-label="Show Rainey"
        onClick={toggle}
      >
        <RaineyMark size={20} />
      </button>
    </>
  )
}

/** A short human label for the current phase — drives the status line. */
function statusFor(phase: Phase, toolName: string | null, connected: boolean, noBackend: boolean): string | null {
  if (noBackend) return null
  if (!connected) return 'Connecting…'
  switch (phase) {
    case 'waiting':
      return 'Thinking…'
    case 'thinking':
      return 'Thinking…'
    case 'tool':
      return `Using ${prettyTool(toolName ?? 'tool')}…`
    case 'writing':
      return 'Writing…'
    default:
      return null
  }
}

/** Tooltip explaining the MCP pill's current state. */
function mcpTitle(status: 'connecting' | 'connected' | 'error', tools: number, noBackend: boolean): string {
  if (noBackend) return 'MCP unavailable — no backend configured'
  if (status === 'connected') return `Connected to the canvas MCP — ${tools} tool${tools === 1 ? '' : 's'} available`
  if (status === 'error') return 'Agent could not reach the canvas MCP server'
  return 'Checking MCP connection… (confirms on the first message)'
}

/** MCP tool names arrive as `mcp__rainey__create_artifact` — show them human-ly. */
function prettyTool(name: string): string {
  const base = name.split('__').pop() ?? name
  return base.replace(/_/g, ' ')
}

// ---- icons -----------------------------------------------------------------

function PanelIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2.8" />
      <path d="M15 5v14" />
    </svg>
  )
}

function SendIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  )
}

function ToolIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 18l3 3 6.5-6.3a4 4 0 0 0 5.2-5.4l-2.7 2.7-2.3-.6-.6-2.3 2.6-2.5Z" />
    </svg>
  )
}

/** Rainey's mark — a compact reindeer/antler glyph in the brand primary. */
function RaineyMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#0C76FF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21c-3 0-5-2-5-5 0-2 1-3 1-5" />
      <path d="M12 21c3 0 5-2 5-5 0-2-1-3-1-5" />
      <path d="M8 11C6.5 9.5 6 7 6 5c1.5 1 2.5 1.5 4 1.5" />
      <path d="M16 11c1.5-1.5 2-4 2-6-1.5 1-2.5 1.5-4 1.5" />
      <path d="M10 6.5c.6.6 1.2.9 2 .9s1.4-.3 2-.9" />
    </svg>
  )
}
