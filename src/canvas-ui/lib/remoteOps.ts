import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { postNative } from './bridge'

/**
 * CanvasOp — the contract the Comms Service emits to drive the canvas.
 *
 * NOTE (see ../../../docs/INTEGRATION_NOTES.md): the canonical design has the agent emit typed
 * *artifacts* and the canvas re-pull on a websocket change-signal. This op layer is the current
 * scaffold; it will be reconciled to render artifacts. The `mergeRemoteChanges` no-echo machinery
 * below stays the same regardless of which shape the ops carry.
 */
export type CanvasOp =
  | { kind: 'addNode'; id?: string; shapeType: string; x: number; y: number; props?: Record<string, unknown> }
  | { kind: 'moveNode'; id: string; x: number; y: number }
  | { kind: 'updateNode'; id: string; props: Record<string, unknown> }
  | { kind: 'deleteNode'; id: string }

const toId = (extId: string): TLShapeId => createShapeId(extId)

/** Apply remote/agent ops WITHOUT echoing them back to the outbound listener (source: 'remote'). */
export function applyRemoteOps(editor: Editor, ops: CanvasOp[]): void {
  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        for (const op of ops) {
          switch (op.kind) {
            case 'addNode': {
              const id = op.id ? toId(op.id) : createShapeId()
              editor.createShape({ id, type: op.shapeType, x: op.x, y: op.y, props: op.props } as any)
              break
            }
            case 'moveNode': {
              const id = toId(op.id)
              const type = editor.getShape(id)?.type
              if (type) editor.updateShape({ id, type, x: op.x, y: op.y } as any)
              break
            }
            case 'updateNode': {
              const id = toId(op.id)
              const type = editor.getShape(id)?.type
              if (type) editor.updateShape({ id, type, props: op.props } as any)
              break
            }
            case 'deleteNode': {
              editor.deleteShapes([toId(op.id)])
              break
            }
          }
        }
      },
      { history: 'ignore' } // remote/agent edits are not user-undoable
    )
  })
}

/** Ship only genuine USER edits back to the Comms Service. Remote ops do NOT trigger this. */
export function attachOutboundSync(editor: Editor): () => void {
  return editor.store.listen(
    (entry) => {
      const payload = {
        type: 'canvasChanges',
        added: Object.values(entry.changes.added),
        updated: Object.values(entry.changes.updated).map((u: any) => u[1]),
        removed: Object.keys(entry.changes.removed),
      }
      postNative(payload)
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.debug('[rainy] user changes', payload)
      }
    },
    { source: 'user', scope: 'document' }
  )
}
