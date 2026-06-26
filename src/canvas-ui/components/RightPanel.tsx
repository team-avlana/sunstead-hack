'use client'

import dynamic from 'next/dynamic'
import { useRainyStore } from '@/lib/store'

/**
 * The right-side assistant panel. Two interchangeable agents ship in the app:
 *
 *   - 'agent'  → <AgentPanel/>: our own assistant built on the Claude Agent SDK,
 *                hosted by the python-service and driving the same MCP tools. This
 *                is the default product experience — no Claude login required, the
 *                service authenticates with a company-owned credential.
 *   - 'claude' → <ClaudePanel/>: the user's own `claude` CLI in a PTY (the original
 *                bring-your-own-agent path), kept for power users.
 *
 * The choice is a persisted store flag (`rightPanel`), flipped from Settings.
 * Both are dynamically imported with ssr:false — AgentPanel is a pure WS chat,
 * ClaudePanel pulls in xterm which touches the DOM on load.
 */
const AgentPanel = dynamic(() => import('./AgentPanel'), { ssr: false })
const ClaudePanel = dynamic(() => import('./ClaudePanel'), { ssr: false })

// Feature flag: our self-built AgentPanel isn't shown publicly yet. While this is
// false the right panel stays pinned to the user's own Claude Code (PTY). Flip to
// true to restore the store-driven choice between AgentPanel and ClaudePanel.
const SHOW_SELF_BUILT_AGENT = false

export default function RightPanel() {
  const mode = useRainyStore((s) => s.rightPanel)
  // While the self-built agent is hidden, force Claude Code regardless of the
  // persisted `rightPanel` flag (also covers any stale 'agent' value left in
  // localStorage from dev sessions).
  if (!SHOW_SELF_BUILT_AGENT) return <ClaudePanel key="claude" />
  // Keyed so flipping modes cleanly tears down one session and starts the other.
  return mode === 'claude' ? <ClaudePanel key="claude" /> : <AgentPanel key="agent" />
}
