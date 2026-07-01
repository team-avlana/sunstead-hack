/**
 * Local video mapping — persist a user-picked local video file against a stable
 * key (a video_id, or failing that the source URL) so a clip whose real media
 * can't be played in the browser (a TikTok/IG *page* URL, or an avlana clip with
 * no hosted media) can still be played back, and the mapping survives reloads.
 *
 * Why this exists: a video's `source_url` is usually the platform page, not a
 * playable file, so the canvas can't drop it into a <video>. The user "maps" a
 * local copy once; we keep the bytes in IndexedDB (canvas-ui is a static export
 * with no server of its own) and replay them on demand.
 *
 * Storage is best-effort: if IndexedDB is unavailable the mapping is simply not
 * persisted (the picked file still plays for the current session via an object
 * URL — see VideoPeek), so callers must tolerate nulls.
 */

const DB_NAME = 'rainy'
const STORE = 'videoMap'
const VERSION = 1

export interface MappedVideo {
  blob: Blob
  name: string
  type: string
  mappedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const t = db.transaction(STORE, mode)
          const req = run(t.objectStore(STORE))
          req.onsuccess = () => resolve(req.result ?? null)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

/** A non-empty, storage-safe key for a clip. Returns null when nothing stable is
 * available (then a mapping can still play for the session but won't persist). */
export function mapKeyFor(videoId?: string | null, sourceUrl?: string | null): string | null {
  if (videoId && videoId.trim()) return `vid:${videoId.trim()}`
  if (sourceUrl && sourceUrl.trim()) return `url:${sourceUrl.trim()}`
  return null
}

export async function getMappedVideo(key: string | null): Promise<MappedVideo | null> {
  if (!key) return null
  const v = await tx<MappedVideo>('readonly', (store) => store.get(key))
  return v && v.blob instanceof Blob ? v : null
}

export async function setMappedVideo(key: string | null, file: File): Promise<boolean> {
  if (!key) return false
  const value: MappedVideo = { blob: file, name: file.name, type: file.type, mappedAt: Date.now() }
  const r = await tx('readwrite', (store) => store.put(value, key))
  return r !== null || true // put resolves to the key; treat a non-throw as success
}

export async function deleteMappedVideo(key: string | null): Promise<void> {
  if (!key) return
  await tx('readwrite', (store) => store.delete(key))
}
