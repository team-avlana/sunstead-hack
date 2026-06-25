/**
 * Drive video analysis for a Video Block from the canvas UI (in-block buttons +
 * sidebar inspector). This is the user-initiated counterpart to the agent path:
 * where the agent calls the analyze_video MCP tool and the WS re-pull renders an
 * artifact-backed block, here a *local* tldraw block triggers POST /api/analyze
 * and then polls GET /api/videos/{id} itself until the analysis lands.
 *
 *   local block        → triggerAnalysis → store video_id + status:'analysing'
 *                       → poll fetchVideoView → merge the live view-model in
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

/** Artifact-backed shapes are id-namespaced by backendCanvas (`shape:art-…`). */
export const isBackendShape = (id: string): boolean => String(id).startsWith('shape:art-')

const POLL_MS = 2500
const POLL_FIRST_MS = 1500

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

// One poll loop per shape — guards against the in-block effect and a sidebar
// trigger both starting a loop for the same block.
const polling = new Set<string>()

/**
 * Poll the analysis of `videoId` and mirror its view-model into the local block,
 * stopping when the status leaves 'analysing' (or the block is gone / re-targeted).
 * Idempotent per shape. Safe to call repeatedly (e.g. from a mount effect).
 */
export function pollVideo(editor: Editor, id: TLShapeId, videoId: string): void {
  if (typeof window === 'undefined' || !hasBackend()) return
  const key = String(id)
  if (polling.has(key)) return
  polling.add(key)

  const stop = () => polling.delete(key)

  const tick = async () => {
    if (editor.isDisposed) return stop()
    const cur = readData(editor, id)
    // Stop if the block vanished, is no longer analysing, or now tracks another video.
    if (!cur || cur.status !== 'analysing' || cur.video_id !== videoId) return stop()

    const vm = await fetchVideoView(videoId)
    if (editor.isDisposed) return stop()
    if (vm) {
      patchData(editor, id, vm)
      if (vm.status && vm.status !== 'analysing') return stop()
    }
    window.setTimeout(tick, POLL_MS)
  }
  window.setTimeout(tick, POLL_FIRST_MS)
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
