// Server component. The client boundary (with the ssr:false dynamic import of
// the tldraw host) lives in CanvasClient — see the tldraw App Router gotchas in
// ../../../knowledge-base/canvas/tldraw-nextjs-integration.md §1.
import CanvasClient from '@/components/CanvasClient'

export default function Page() {
  return <CanvasClient />
}
