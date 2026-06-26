/**
 * Drive video analysis for a Video Block from the canvas UI (in-block buttons +
 * sidebar inspector). This is the user-initiated counterpart to the agent path:
 * where the agent calls the analyze_video MCP tool and the WS re-pull renders an
 * artifact-backed block, here a *local* tldraw block triggers POST /api/analyze
 * and then watches a per-video websocket (`/ws?video_id=…`) for pushed stage/done
 * signals until the analysis lands — no tight polling loop.
 *
 *   local block        → triggerAnalysis → store video_id + status:'analysing'
 *                       → subscribeVideoSignal → on each signal re-pull the view-
 *                          model and merge it in (slow safety poll backs it up)
 *   backend element     → reanalyzeVideo(video_id); the existing realtime re-pull
 *     (shape:art-…)        (lib/realtime.ts) renders progress — we never poll or
 *                          patch it locally, so the two paths can't fight.
 *
 * All shape mutations go through editor.updateShape with history:'ignore' via the
 * caller's run; we read the freshest shape each tick so concurrent edits/poll
 * loops stay consistent.
 */

import { type Editor, type TLShapeId } from 'tldraw'
import { VIDEO_BLOCK, dims, parse, type VideoData, type VideoView } from '@/lib/blockTypes'
import { fetchVideoView, hasBackend, reanalyzeVideo, triggerAnalysis } from '@/lib/api'
import { subscribeVideoSignal } from '@/lib/realtime'

/** Artifact-backed shapes are id-namespaced by backendCanvas (`shape:art-…`). */
export const isBackendShape = (id: string): boolean => String(id).startsWith('shape:art-')

// Updates are PUSHED over a per-video websocket (subscribeVideoSignal); this slow
// fallback only covers a dropped/missed signal so a block can never strand on
// 'analysing'. It's a safety net, not the primary mechanism (was a 2.5s poll).
const SAFETY_MS = 20000

function readData(editor: Editor, id: TLShapeId): VideoData | null {
  const sh = editor.getShape(id)
  if (!sh || sh.type !== VIDEO_BLOCK) return null
  return parse(String((sh.props as { data?: string }).data ?? ''))
}

/** Merge a patch into the block's JSON `data` and refit the box to its view. */
function patchData(editor: Editor, id: TLShapeId, next: Partial<VideoData>): void {
  if (editor.isDisposed) return
  const sh = editor.getShape(id)
  if (!sh || sh.type !== VIDEO_BLOCK) return
  const cur = parse(String((sh.props as { data?: string }).data ?? ''))
  const merged = { ...cur, ...next }
  const view = (String((sh.props as { view?: string }).view || 'compact') as VideoView)
  const size = dims(view, merged)
  editor.updateShape({ id, type: VIDEO_BLOCK, props: { data: JSON.stringify(merged), ...size } })
}

// One watcher per shape, keyed PER EDITOR — guards against the in-block effect and
// a sidebar trigger both starting a watcher for the same block. Keyed by editor
// (WeakMap) rather than a global so a fast project remount gets a fresh, empty
// guard map: a stale watcher bound to the disposed editor can never suppress the
// new editor's watch (which previously stranded a local video on 'analysing'), and
// the entry is GC'd with the editor. The value is the watcher's teardown.
const watching = new WeakMap<Editor, Map<string, () => void>>()

/**
 * Watch the analysis of `videoId` and mirror its view-model into the local block,
 * stopping when the status leaves 'analysing' (or the block is gone / re-targeted).
 *
 * Updates are PUSHED over a per-video websocket — the service signals each stage
 * transition + done/error — so this no longer polls on a tight loop. A one-shot
 * catch-up fetch (in case the analysis advanced before we subscribed) and a slow
 * SAFETY_MS fallback poll guard against a missed signal. Idempotent per shape;
 * safe to call repeatedly (e.g. from a mount effect).
 */
export function pollVideo(editor: Editor, id: TLShapeId, videoId: string): void {
  if (typeof window === 'undefined' || !hasBackend()) return
  const key = String(id)
  let m = watching.get(editor)
  if (!m) {
    m = new Map<string, () => void>()
    watching.set(editor, m)
  }
  const map = m
  if (map.has(key)) return

  let stopped = false
  let unsub: (() => void) | null = null
  let safety: number | undefined

  const stop = () => {
    if (stopped) return
    stopped = true
    if (unsub) unsub()
    window.clearTimeout(safety)
    map.delete(key)
  }

  // Re-pull the view-model and reconcile it into the block; tear down once the
  // analysis lands (or the block vanished / now tracks another video).
  const refresh = async () => {
    if (stopped || editor.isDisposed) return stop()
    const cur = readData(editor, id)
    if (!cur || cur.status !== 'analysing' || cur.video_id !== videoId) return stop()
    const vm = await fetchVideoView(videoId)
    if (stopped || editor.isDisposed) return
    if (vm) {
      patchData(editor, id, vm)
      if (vm.status && vm.status !== 'analysing') return stop()
    }
  }

  map.set(key, stop)

  // Primary: push. Re-pull on every change-signal for this video.
  unsub = subscribeVideoSignal(videoId, () => void refresh())

  // Catch-up now (an update may have landed before we subscribed) + slow safety net.
  void refresh()
  const tick = () => {
    if (stopped) return
    void refresh()
    safety = window.setTimeout(tick, SAFETY_MS)
  }
  safety = window.setTimeout(tick, SAFETY_MS)
}

/**
 * Start (or retry) analysis for a Video Block.
 *  - `urlArg` set        → analyse that URL (the in-block / sidebar URL field).
 *  - no `urlArg`, has id  → re-run the existing video (the Retry action).
 *  - no `urlArg`, has url  → analyse the stored source_url.
 */
export async function analyseVideoShape(
  editor: Editor,
  id: TLShapeId,
  urlArg?: string,
): Promise<void> {
  const d = readData(editor, id)
  if (!d) return
  const backend = isBackendShape(String(id))
  const url = (urlArg ?? '').trim()

  if (!hasBackend()) {
    if (!backend) {
      patchData(editor, id, {
        status: 'error',
        source_url: url || d.source_url || null,
        analysis_error:
          'Analysis service not connected. Start the python-service and set NEXT_PUBLIC_RAINY_API_URL.',
      })
    }
    return
  }

  // Artifact-backed element: re-run the same video; realtime re-pull shows progress.
  if (backend) {
    if (d.video_id) await reanalyzeVideo(d.video_id)
    return
  }

  // New URL → fresh analysis (a new videos row).
  if (url) {
    patchData(editor, id, { status: 'analysing', source_url: url, analysis_error: null })
    const res = await triggerAnalysis(url)
    if (!res?.video_id) {
      patchData(editor, id, { status: 'error', source_url: url, analysis_error: 'Could not start analysis.' })
      return
    }
    patchData(editor, id, { status: 'analysing', source_url: url, video_id: res.video_id })
    pollVideo(editor, id, res.video_id)
    return
  }

  // Retry / analyse what's already on the block.
  if (d.video_id) {
    patchData(editor, id, { status: 'analysing', analysis_error: null })
    const ok = await reanalyzeVideo(d.video_id)
    if (!ok) {
      patchData(editor, id, { status: 'error', analysis_error: 'Could not start analysis.' })
      return
    }
    pollVideo(editor, id, d.video_id)
    return
  }
  if (d.source_url) {
    patchData(editor, id, { status: 'analysing', analysis_error: null })
    const res = await triggerAnalysis(d.source_url)
    if (!res?.video_id) {
      patchData(editor, id, { status: 'error', analysis_error: 'Could not start analysis.' })
      return
    }
    patchData(editor, id, { status: 'analysing', video_id: res.video_id })
    pollVideo(editor, id, res.video_id)
  }
}
