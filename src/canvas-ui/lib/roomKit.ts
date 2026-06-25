/**
 * Creator Room Kit — the CC0 GLB asset registry (the "asset catalog").
 *
 * Each asset is a **Quaternius** model (CC0 — no attribution required) fetched
 * from Poly Pizza into `public/vendor/assets/<id>.glb` by
 * `scripts/fetch-assets.mjs`. These GLBs are the hero-fidelity layer: loaded via
 * GLTFLoader and dropped into the matching zone of the fixed room skeleton. The
 * procedural room in `creatorRoom.ts` (`buildRoomDoc`) stays the offline fallback.
 *
 * Browse them: `public/asset-showroom.html`. Plan: `docs/CREATOR_ROOM_KIT.md`.
 */

export type KitZone = 'library' | 'filming' | 'table' | 'ambient' | 'companions'

export interface KitAsset {
  /** Stable id + base filename (`<id>.glb`). */
  id: string
  file: string
  /** Where it belongs in the room skeleton. */
  zone: KitZone
  /** Human label (used in the showroom + any chooser UI). */
  title: string
  author: string
  /** CC0 only — keep it attribution-free (see docs §7). */
  license: 'CC0'
  /** Poly Pizza source page. */
  source: string
}

/** GLBs are served from Next's `public/` → `/vendor/assets/...`. */
export const ASSET_BASE = '/vendor/assets'
export const assetUrl = (a: KitAsset | string): string =>
  `${ASSET_BASE}/${typeof a === 'string' ? a : a.file}`

/**
 * The curated CC0 kit (fetched 2026-06-25). Regenerate / extend with
 * `node scripts/fetch-assets.mjs` after editing its slug list.
 */
export const KIT_ASSETS: KitAsset[] = [
  { id: 'chair', file: 'chair.glb', zone: 'filming', title: 'Chair', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/iMNqRzPwwe' },
  { id: 'desk', file: 'desk.glb', zone: 'filming', title: 'Desk', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/V86Go2rlnq' },
  { id: 'table-round', file: 'table-round.glb', zone: 'table', title: 'Round Table', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/oEArSZykyi' },
  { id: 'bookcase', file: 'bookcase.glb', zone: 'library', title: 'Bookcase', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/tACDGJ4CGW' },
  { id: 'cabinet-shelves', file: 'cabinet-shelves.glb', zone: 'library', title: 'Cabinet Shelves', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/u3A1t5DIMd' },
  { id: 'floor-lamp', file: 'floor-lamp.glb', zone: 'ambient', title: 'Floor Lamp', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/eBQtooeh43' },
  { id: 'table-lamp', file: 'table-lamp.glb', zone: 'ambient', title: 'Table Lamp', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/9Mo3JruPHY' },
  { id: 'plant', file: 'plant.glb', zone: 'library', title: 'Houseplant', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/bfLOqIV5uP' },
  { id: 'sofa', file: 'sofa.glb', zone: 'companions', title: 'Sofa', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/X5kQPKzAWp' },
  { id: 'couch', file: 'couch.glb', zone: 'companions', title: 'Couch', author: 'Quaternius', license: 'CC0', source: 'https://poly.pizza/m/mWgQ94zhDZ' },
]

export const assetsByZone = (zone: KitZone): KitAsset[] => KIT_ASSETS.filter((a) => a.zone === zone)
export const assetById = (id: string): KitAsset | undefined => KIT_ASSETS.find((a) => a.id === id)
