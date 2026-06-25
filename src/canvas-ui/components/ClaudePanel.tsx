'use client'

import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { wsBase } from '@/lib/api'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'

/**
 * The Claude Code panel — the user's own `claude` CLI, hosted in a pseudo-
 * terminal by the python-service and rendered here with xterm.js (Option A:
 * host the real TUI, no custom agent). Mirrors the left Sidebar's glass-card
 * shell + GSAP collapse, but anchored to the right of the infinite canvas.
 *
 * The session is created once on mount and kept alive across collapse (the
 * panel only slides off-screen), so toggling the panel never drops your
 * conversation. Output arrives as binary ws frames; keystrokes + resizes go
 * back as JSON. See ../../python-service/pty_bridge.py for the protocol.
 */
export default function ClaudePanel() {
  const ref = useRef<HTMLElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const open = useRainyStore((s) => s.claudePanelOpen)
  const toggle = useRainyStore((s) => s.toggleClaudePanel)
  const dark = useRainyStore((s) => s.dark)

  // Live terminal + socket handles, so the dark-mode effect below can retheme
  // without tearing the session down.
  const termRef = useRef<Terminal | null>(null)

  // ---- terminal + websocket lifecycle (once) ------------------------------
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    let disposed = false
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let ws: WebSocket | null = null
    let reconnect: number | undefined
    let ro: ResizeObserver | undefined
    const enc = new TextEncoder()

    const send = (msg: object) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    const pushResize = () => {
      if (!term || !fit) return
      try {
        fit.fit()
      } catch {
        /* host not laid out yet */
      }
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    }

    const connect = () => {
      const base = wsBase()
      if (!base || disposed || !term) return
      try {
        ws = new WebSocket(`${base}/pty`)
      } catch {
        return scheduleReconnect()
      }
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        term?.write('\x1b[2J\x1b[H') // clear the "reconnecting…" notice
        pushResize()
        term?.focus()
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') term?.write(ev.data)
        else term?.write(new Uint8Array(ev.data as ArrayBuffer))
      }
      ws.onclose = () => {
        ws = null
        if (!disposed) {
          term?.write('\r\n\x1b[2m[claude session ended — reconnecting…]\x1b[0m\r\n')
          scheduleReconnect()
        }
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

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed) return

      term = new Terminal({
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 1.25,
        cursorBlink: true,
        allowTransparency: true,
        // Lift Claude's dim/gray ANSI text to a readable contrast (xterm
        // adjusts per-glyph at render). Kept moderate so brand-colored accents
        // — e.g. the blue selected menu option — aren't muted toward gray.
        minimumContrastRatio: 4.5,
        theme: themeFor(useRainyStore.getState().dark),
        scrollback: 5000,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term

      term.onData((data) => send({ type: 'input', data }))

      ro = new ResizeObserver(() => pushResize())
      ro.observe(host)

      if (!wsBase()) {
        term.write(
          '\x1b[2m  Claude Code is not connected.\r\n' +
            '  Set NEXT_PUBLIC_RAINY_API_URL and start the python-service to host it here.\x1b[0m\r\n',
        )
        return
      }
      pushResize()
      connect()
    })()

    return () => {
      disposed = true
      window.clearTimeout(reconnect)
      ro?.disconnect()
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      term?.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Retheme in place when canvas dark mode flips (no session teardown).
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = themeFor(dark)
  }, [dark])

  // ---- panel shell: intro + collapse (mirrors Sidebar, right-anchored) ----
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
    const hideX = el.offsetWidth + 28 // width + right inset + shadow, fully off-screen
    gsap.to(el, {
      x: open ? 0 : hideX,
      autoAlpha: open ? 1 : 0,
      duration: 0.42,
      ease: open ? 'power3.out' : 'power3.in',
      overwrite: 'auto',
      onComplete: () => {
        // Refit once the slide settles so the TUI fills the revealed width.
        if (open) termRef.current?.focus()
      },
    })
  }, [open])

  return (
    <>
      <aside className="rainy-claude" ref={ref}>
        <div className="cc">
          <div className="cc-head">
            <div className="cc-title">
              <ClaudeMark />
              <span>Claude Code</span>
            </div>
            <button
              type="button"
              className="cc-collapse"
              title="Hide Claude"
              aria-label="Hide Claude"
              onClick={toggle}
            >
              <PanelIcon size={18} />
            </button>
          </div>
          <div className="cc-term" ref={mountRef} />
        </div>
      </aside>

      <button
        type="button"
        className={`rainy-claude-show${!open ? ' show' : ''}`}
        title="Show Claude"
        aria-label="Show Claude"
        onClick={toggle}
      >
        <ClaudeMark size={20} />
      </button>
    </>
  )
}

/** xterm color theme tuned to the app's light/dark glass surfaces. */
function themeFor(dark: boolean) {
  return dark
    ? {
        // A near-opaque dark surface so text isn't washed out by the moving
        // canvas behind the glass; minimumContrastRatio handles dim text.
        background: 'rgba(20, 24, 34, 0.94)',
        foreground: '#f1f3f8',
        cursor: '#cdd3e0',
        selectionBackground: 'rgba(120,150,255,0.35)',
        black: '#2a2f3c',
        brightBlack: '#7c879b',
        // Selected option / accents → brand blue (brightened for dark glass).
        blue: '#4d9bff',
        brightBlue: '#73b3ff',
        cyan: '#4d9bff',
        brightCyan: '#73b3ff',
      }
    : {
        // Near-opaque light surface → crisp, near-black text.
        background: 'rgba(249, 250, 252, 0.95)',
        foreground: '#0b0d14',
        cursor: '#0C76FF',
        selectionBackground: 'rgba(12,118,255,0.20)',
        black: '#0b0d14',
        brightBlack: '#3a4255',
        white: '#0b0d14',
        brightWhite: '#000000',
        // Selected option / accents → our brand primary, strongly visible.
        blue: '#0C76FF',
        brightBlue: '#3b8bff',
        cyan: '#0C76FF',
        brightCyan: '#3b8bff',
      }
}

// ---- icons -----------------------------------------------------------------

/** SF-Symbols-style `sidebar.right` glyph (trailing divider column). */
function PanelIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2.8" />
      <path d="M15 5v14" />
    </svg>
  )
}

/** Compact Claude "sunburst" mark. */
function ClaudeMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#D77757" aria-hidden>
      <path d="M12 2.4c.3 2.6.9 4.1 1.9 5.1 1 1 2.5 1.6 5.1 1.9-2.6.3-4.1.9-5.1 1.9-1 1-1.6 2.5-1.9 5.1-.3-2.6-.9-4.1-1.9-5.1-1-1-2.5-1.6-5.1-1.9 2.6-.3 4.1-.9 5.1-1.9 1-1 1.6-2.5 1.9-5.1Z" />
    </svg>
  )
}
