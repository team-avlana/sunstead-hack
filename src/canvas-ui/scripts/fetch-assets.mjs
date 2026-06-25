/**
 * Fetch the curated CC0 (Quaternius) GLBs from Poly Pizza into
 * public/vendor/assets/. Run: `node scripts/fetch-assets.mjs`
 *
 * Recipe (validated): a Poly Pizza model page `poly.pizza/m/<slug>` embeds the
 * real asset URL `https://static.poly.pizza/<uuid>.glb` (uuid != slug). We scrape
 * that URL from the page, then download it. Keep this list CC0-only (Quaternius).
 * Edit ITEMS and re-run to extend the kit; then mirror the new entries into
 * lib/roomKit.ts. See docs/CREATOR_ROOM_KIT.md.
 */
import { mkdir, writeFile } from 'node:fs/promises'

const DEST = new URL('../public/vendor/assets/', import.meta.url)

// id | slug | zone | title   (all Quaternius, CC0)
const ITEMS = [
  ['chair', 'iMNqRzPwwe', 'filming', 'Chair'],
  ['desk', 'V86Go2rlnq', 'filming', 'Desk'],
  ['table-round', 'oEArSZykyi', 'table', 'Round Table'],
  ['bookcase', 'tACDGJ4CGW', 'library', 'Bookcase'],
  ['cabinet-shelves', 'u3A1t5DIMd', 'library', 'Cabinet Shelves'],
  ['floor-lamp', 'eBQtooeh43', 'ambient', 'Floor Lamp'],
  ['table-lamp', '9Mo3JruPHY', 'ambient', 'Table Lamp'],
  ['plant', 'bfLOqIV5uP', 'library', 'Houseplant'],
  ['sofa', 'X5kQPKzAWp', 'companions', 'Sofa'],
  ['couch', 'mWgQ94zhDZ', 'companions', 'Couch'],
]

await mkdir(DEST, { recursive: true })
const manifest = []
let ok = 0

for (const [id, slug, zone, title] of ITEMS) {
  try {
    const page = await fetch(`https://poly.pizza/m/${slug}`).then((r) => r.text())
    const m = page.match(/static\.poly\.pizza\/[a-f0-9-]{36}\.glb/)
    if (!m) { console.log(`  MISS  ${id} (${slug}) — no glb url on page`); continue }
    const url = `https://${m[0]}`
    const buf = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()))
    if (buf.subarray(0, 4).toString() !== 'glTF') { console.log(`  FAIL  ${id} — not a glb`); continue }
    await writeFile(new URL(`${id}.glb`, DEST), buf)
    manifest.push({ id, file: `${id}.glb`, zone, title, slug, source: `https://poly.pizza/m/${slug}`, author: 'Quaternius', license: 'CC0' })
    console.log(`  OK    ${id}  <- ${slug}  (${buf.length} bytes)`)
    ok++
  } catch (e) {
    console.log(`  ERR   ${id} (${slug}) — ${e.message}`)
  }
}

await writeFile(new URL('_manifest.json', DEST), JSON.stringify(manifest, null, 2) + '\n')
console.log(`---- ${ok}/${ITEMS.length} assets in ${DEST.pathname}`)
