import { createShapeId, type Editor } from 'tldraw'
import { RAINY_TEXT } from '@/components/RainyTextShape'
import { loadProject, saveProject, type Project, type RainyShape } from './projects'
import { useRainyStore } from './store'

/** tldraw shape ids are `shape:<x>`; we store just `<x>` in the XML for cleanliness. */
const stem = (id: string) => id.replace(/^shape:/, '')

/**
 * Pull a project's XML into a freshly-mounted editor.
 *
 * Runs inside `mergeRemoteChanges` + `history: 'ignore'` so the load is treated as
 * a remote sync: it neither lands in the undo stack nor trips the user-scoped
 * autosave listener (which would otherwise re-save on open).
 */
export async function loadProjectIntoEditor(editor: Editor, id: string): Promise<void> {
  let project: Project
  try {
    project = await loadProject(id)
  } catch {
    return
  }
  if (editor.isDisposed) return

  useRainyStore.getState().setTitle(project.title)

  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        const existing = editor.getCurrentPageShapes().map((s) => s.id)
        if (existing.length) editor.deleteShapes(existing)
        for (const sh of project.shapes) {
          try {
            editor.createShape({ id: createShapeId(sh.id), type: sh.type, x: sh.x, y: sh.y, props: sh.props } as any)
          } catch {
            /* skip shapes that fail validation (e.g. an unknown type) */
          }
        }
      },
      { history: 'ignore' }
    )
  })

  if (project.shapes.length) {
    try {
      editor.zoomToFit()
    } catch {
      /* no-op */
    }
  }
}

function snapshotShapes(editor: Editor): RainyShape[] {
  return editor
    .getCurrentPageShapes()
    .filter((s) => s.type === RAINY_TEXT)
    .map((s) => {
      const props = (s as any).props
      return {
        id: stem(s.id),
        type: s.type,
        x: Math.round(s.x),
        y: Math.round(s.y),
        props: { w: props.w, h: props.h, html: props.html ?? '' },
      }
    })
}

/**
 * Persist genuine USER edits back to the project's XML (debounced). Remote/agent
 * ops and the initial load are `source: 'remote'`, so they never trigger a save.
 */
export function attachProjectAutosave(editor: Editor, id: string): () => void {
  let timer: number | undefined
  const save = () => {
    const title = useRainyStore.getState().currentProjectTitle || 'Untitled project'
    saveProject({ id, title, updated: new Date().toISOString(), shapes: snapshotShapes(editor) })
  }
  const unsub = editor.store.listen(
    () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(save, 500)
    },
    { source: 'user', scope: 'document' }
  )
  return () => {
    window.clearTimeout(timer)
    unsub()
  }
}
