/**
 * Creator Room — the templated 3D diorama.
 *
 * Design contract (see the build brief): a **fixed skeleton + variable payload**.
 * The room geometry, the five named zones, the camera, and the lighting never
 * change; only the *objects inside each zone* change per creator.
 *
 *   library      → back wall  (the creator's mind: interests, reads, role models)
 *   content      → floor centre (how they actually shoot: gear, tripod, rig)
 *   referral     → side/window wall (what they recommend & monetise — hotspots)
 *   style        → whole-room finish (palette, lighting, materials)
 *   companions   → soft props (pet, mug, lamp — warmth)
 *
 * Rendering: the room runs as a **self-contained three.js document** inside a
 * sandboxed <iframe srcdoc>. That keeps three.js out of the Next bundle, safely
 * isolates generated code, and works in both the web app and the WKWebView shell.
 * `buildRoomDoc()` is the deterministic procedural renderer (instant + offline +
 * the fallback); `generateRoomDoc()` asks the Python Comms Service to have Claude
 * generate a bespoke document for the same profile.
 */

// ---------------------------------------------------------------------------
// Profile (Section 4 of the brief, trimmed to what the v1 renderer reads)
// ---------------------------------------------------------------------------

export type Shooter = 'iphone' | 'dslr' | 'mirrorless' | 'webcam' | 'podcast'
export type Lighting = 'warm' | 'neutral' | 'moody' | 'bright'
export type Pet = 'cat' | 'dog' | 'none'

export interface CreatorProfile {
  creator: { name: string; niche: string; vibe: string[] }
  library: { interests: string[]; reads: string[]; shows: string[]; roleModels: string[] }
  content: { shooter: Shooter; gear: string[]; editingApp: string }
  referral: { tech: { label: string; link?: string }[]; lifestyle: { label: string; link?: string }[] }
  style: { palette: string[]; lighting: Lighting; materials: string }
  companions: { pet: Pet; props: string[] }
}

/** A polished, reference-matching default (cozy tech/lifestyle vlogger + a cat). */
export const DEFAULT_PROFILE: CreatorProfile = {
  creator: { name: 'Avlana', niche: 'tech & lifestyle vlogs', vibe: ['cozy', 'warm', 'minimal'] },
  library: {
    interests: ['photography', 'coffee', 'travel', 'design'],
    reads: ['Deep Work', 'Show Your Work', 'Steal Like an Artist', 'Atomic Habits', 'On Writing'],
    shows: ['Chef', 'Lost in Translation'],
    roleModels: ['Casey', 'Peter'],
  },
  content: {
    shooter: 'mirrorless',
    gear: ['softbox', 'shotgun mic', 'gimbal'],
    editingApp: 'Premiere Pro',
  },
  referral: {
    tech: [
      { label: 'My camera kit', link: 'https://example.com/gear' },
      { label: 'My desk setup', link: 'https://example.com/desk' },
    ],
    lifestyle: [{ label: 'My Spotify playlist', link: 'https://open.spotify.com' }],
  },
  style: { palette: ['#E8C9A0', '#C98A5E', '#8FA98C', '#D9B08C'], lighting: 'warm', materials: 'wood+linen' },
  companions: { pet: 'cat', props: ['latte mug', 'headphones', 'paper lantern'] },
}

// ---------------------------------------------------------------------------
// localStorage persistence (so the room survives reloads with no backend)
// ---------------------------------------------------------------------------

const LS = {
  profile: 'rainy:room:profile',
  html: 'rainy:room:html',
  origin: 'rainy:room:origin',
  image: 'rainy:room:image',
  mode: 'rainy:room:mode',
}
const ls = (): Storage | null => (typeof window !== 'undefined' ? window.localStorage : null)

/** The two render modes. Image (clay-render PNG) is the default. */
export type RoomMode = 'image' | 'room3d'

/** Bundled reference-style sample shown (blurred) until a real image is generated. */
export const SAMPLE_IMAGE = '/creator-room/sample.png'

/** The default Creator Room hero shown (clean, un-blurred) until the creator
 *  designs their own. A polished clay-render reference room. */
export const DEFAULT_ROOM_IMAGE = '/creator-room/default.png'

export function loadMode(): RoomMode {
  return ls()?.getItem(LS.mode) === 'room3d' ? 'room3d' : 'image'
}
export function saveMode(m: RoomMode): void {
  ls()?.setItem(LS.mode, m)
}

/** Persist the last generated image (best-effort — base64 PNGs can blow the quota). */
export function saveGeneratedImage(dataUrl: string): void {
  try {
    ls()?.setItem(LS.image, dataUrl)
  } catch {
    /* quota exceeded — the image just won't survive a reload */
  }
}
export function loadGeneratedImage(): string | null {
  return ls()?.getItem(LS.image) ?? null
}
export function clearGeneratedImage(): void {
  ls()?.removeItem(LS.image)
}

export function loadProfile(): CreatorProfile {
  try {
    const raw = ls()?.getItem(LS.profile)
    if (raw) return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as CreatorProfile) }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PROFILE
}

export function saveProfile(p: CreatorProfile): void {
  ls()?.setItem(LS.profile, JSON.stringify(p))
}

/** Remember the last generated room so the hero loads instantly next visit. */
export function saveGeneratedRoom(html: string): void {
  ls()?.setItem(LS.html, html)
  ls()?.setItem(LS.origin, 'generated')
}
export function loadGeneratedRoom(): string | null {
  return ls()?.getItem(LS.origin) === 'generated' ? (ls()?.getItem(LS.html) ?? null) : null
}
export function clearGeneratedRoom(): void {
  ls()?.removeItem(LS.html)
  ls()?.removeItem(LS.origin)
}

// ---------------------------------------------------------------------------
// Live generation — POST the profile to the Python Comms Service
// ---------------------------------------------------------------------------

/** Base HTTP API on the Comms Service (Postgres reads, generation, …). */
export function apiBase(): string | null {
  const v = process.env.NEXT_PUBLIC_COMMS_API_URL
  if (v && v.trim()) return v.replace(/\/$/, '')
  // Dev convenience: with no env var set, assume the local Comms Service on :8787
  // when we're on localhost, so `npm run dev` + uvicorn "just works". Deployed
  // (non-localhost) hosts must set NEXT_PUBLIC_COMMS_API_URL explicitly.
  if (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    return 'http://localhost:8787/api'
  }
  return null
}

export class GenerationUnavailable extends Error {}

/**
 * Ask Claude (via the Comms Service) to generate a bespoke room document for
 * this profile. Throws `GenerationUnavailable` when no service is configured,
 * so the caller can fall back to the procedural `buildRoomDoc`.
 */
export async function generateRoomDoc(profile: CreatorProfile, signal?: AbortSignal): Promise<string> {
  const base = apiBase()
  if (!base) throw new GenerationUnavailable('No NEXT_PUBLIC_COMMS_API_URL configured')

  const res = await fetch(`${base}/creator-room/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Generation failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const data = (await res.json()) as { html?: string }
  if (!data.html || !/<html|<canvas|three/i.test(data.html)) {
    throw new Error('Generation returned an unexpected document')
  }
  return data.html
}

/** The few onboarding answers that seed a full profile. */
export interface ProfileSeed {
  niche: string
  vibe: string[]
  name: string
  pet: Pet
}

/**
 * Expand a few onboarding answers into a full CreatorProfile. Uses the Comms
 * Service (LLM autofill) when available; otherwise falls back to a local
 * DEFAULT + seed merge so onboarding always completes. Never throws.
 */
export async function autofillProfile(seed: ProfileSeed, signal?: AbortSignal): Promise<CreatorProfile> {
  const base = apiBase()
  if (base) {
    try {
      const res = await fetch(`${base}/creator-room/autofill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
        signal,
      })
      if (res.ok) {
        const data = (await res.json()) as { profile?: CreatorProfile }
        if (data.profile?.creator) return data.profile
      }
    } catch {
      /* fall through to local merge */
    }
  }
  // Local fallback — DEFAULT enriched with the seed answers.
  return {
    ...DEFAULT_PROFILE,
    creator: {
      name: seed.name.trim() || 'Creator',
      niche: seed.niche.trim() || DEFAULT_PROFILE.creator.niche,
      vibe: seed.vibe.length ? seed.vibe : DEFAULT_PROFILE.creator.vibe,
    },
    companions: { ...DEFAULT_PROFILE.companions, pet: seed.pet },
  }
}

/**
 * Render a clay-diorama IMAGE of the room (the default mode) via the Comms
 * Service → gpt-image-1. Returns a data URL. Throws `GenerationUnavailable`
 * when no service is configured (caller falls back to the sample image).
 */
export async function generateRoomImage(profile: CreatorProfile, signal?: AbortSignal): Promise<string> {
  const base = apiBase()
  if (!base) throw new GenerationUnavailable('No NEXT_PUBLIC_COMMS_API_URL configured')

  const res = await fetch(`${base}/creator-room/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Image generation failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const data = (await res.json()) as { image?: string }
  if (!data.image || !data.image.startsWith('data:image/')) {
    throw new Error('Image generation returned no image')
  }
  return data.image
}

// ---------------------------------------------------------------------------
// Procedural renderer — the deterministic skeleton+payload room document
// ---------------------------------------------------------------------------

/** Build a complete, self-contained three.js HTML document for the iframe. */
export function buildRoomDoc(profile: CreatorProfile): string {
  // JSON-encode the payload, escaping `<` so a stray "</script>" in user text
  // can never break out of the module script.
  const payload = JSON.stringify(profile).replace(/</g, '\\u003c')
  // Use a replacer function so `$`-sequences in user text (e.g. "$5") are inserted
  // literally rather than interpreted by String.replace ($$, $&, …).
  return ROOM_DOC.replace('"__RAINY_PROFILE__"', () => payload)
}

// The document is one big template string. The embedded module deliberately uses
// NO backticks and NO `${}` so it survives this outer template literal verbatim.
const ROOM_DOC = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Creator Room</title>
<style>
  html, body { margin: 0; height: 100%; background: #ffffff; overflow: hidden; }
  #c { display: block; width: 100vw; height: 100vh; cursor: grab; }
  #c.grabbing { cursor: grabbing; }
  #c.point { cursor: pointer; }
  .hud { position: fixed; pointer-events: none; user-select: none;
         font: 600 11px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #label { left: 16px; bottom: 14px; color: #aab0bd; letter-spacing: .02em; }
  #tip   { right: 16px; bottom: 14px; color: #c2c7d1; font-weight: 500; }
  /* avatar variant cycler — lets you "pick" a look */
  .pick { position: fixed; left: 16px; top: 14px; display: flex; align-items: center; gap: 8px;
          pointer-events: auto; user-select: none;
          font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #8a8f9c; }
  .pick button { width: 24px; height: 24px; border-radius: 999px; border: 1px solid rgba(20,28,60,.12);
          background: rgba(255,255,255,.72); color: #5a6072; cursor: pointer; font-size: 11px; line-height: 1; }
  .pick button:hover { background: #fff; }
  .pick span { min-width: 64px; text-align: center; letter-spacing: .02em; }
</style>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
}}
</script>
</head>
<body>
<canvas id="c"></canvas>
<div class="hud" id="label"></div>
<div class="hud" id="tip">drag to orbit · scroll to zoom</div>
<div class="pick" id="pick"><button id="prev" title="Previous avatar">&#9664;</button><span id="pickLabel">Avatar 1</span><button id="next" title="Next avatar">&#9654;</button></div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const PROFILE = "__RAINY_PROFILE__";
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- derived style -------------------------------------------------------
const vibeFallback = ['#E8C9A0', '#C98A5E', '#8FA98C', '#D9B08C'];
const palette = (PROFILE.style && PROFILE.style.palette && PROFILE.style.palette.length)
  ? PROFILE.style.palette : vibeFallback;
const LIGHTING = {
  warm:    { sky: 0xfff1dd, ground: 0x8a7656, key: 0xffe7c2, keyInt: 1.5, amb: 0.35, env: 1.05, exposure: 1.12, lantern: 0xffcaa0, clear: 0xffffff },
  neutral: { sky: 0xf2f4f8, ground: 0x6a6d75, key: 0xfff6ea, keyInt: 1.4, amb: 0.4,  env: 1.05, exposure: 1.05, lantern: 0xfff4e0, clear: 0xffffff },
  moody:   { sky: 0x3a4150, ground: 0x1c1f28, key: 0xb7c6ff, keyInt: 1.1, amb: 0.25, env: 0.55, exposure: 0.98, lantern: 0xff9f6b, clear: 0xf5f6f9 },
  bright:  { sky: 0xffffff, ground: 0xb6bcc6, key: 0xffffff, keyInt: 1.7, amb: 0.5,  env: 1.35, exposure: 1.18, lantern: 0xffffff, clear: 0xffffff },
};
const L = LIGHTING[(PROFILE.style && PROFILE.style.lighting) || 'warm'] || LIGHTING.warm;
const WALL = 0xf3ecdf, SOFA = 0xeaddc6;

// ---- deterministic tiny PRNG (stable layout per profile) -----------------
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
function pick(arr, seed) { return arr[hash(String(seed)) % arr.length]; }

// ---- renderer / scene ----------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setClearColor(L.clear, 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// AgX tone mapping keeps warm hues true (ACES hue-shifts terracotta->yellow) and
// gives the soft, photographic roll-off that reads as clay. OutputPass applies it.
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = L.exposure;

const scene = new THREE.Scene();
// Image-based lighting (soft, room-like ambient) — the key to the clay render.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = L.env;

const FRUST = 6.6;
const camera = new THREE.OrthographicCamera(-FRUST, FRUST, FRUST, -FRUST, 0.1, 100);
camera.position.set(11, 9.5, 11);
camera.zoom = 1;

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.7, 0);
controls.enablePan = false;
controls.minPolarAngle = 0.55;
controls.maxPolarAngle = 1.18;
// Azimuth is left free so the gentle auto-rotate reads as a smooth turntable
// (clamping it would make auto-rotate drift into the limit and freeze).
controls.minZoom = 0.7;
controls.maxZoom = 2.4;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotate = !reduced;
controls.autoRotateSpeed = 0.5;
canvas.addEventListener('pointerdown', () => canvas.classList.add('grabbing'));
addEventListener('pointerup', () => canvas.classList.remove('grabbing'));

// ---- lights --------------------------------------------------------------
scene.add(new THREE.HemisphereLight(L.sky, L.ground, L.amb));
const key = new THREE.DirectionalLight(L.key, L.keyInt);
key.position.set(6, 12, 8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.radius = 6;
key.shadow.bias = -0.0004;
const sc = key.shadow.camera;
sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 40;
sc.updateProjectionMatrix();
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-8, 6, 4);
scene.add(fill);

// ---- material + geometry helpers -----------------------------------------
function clay(color) {
  // Clay surface: high roughness, zero metalness (metalness reads plastic), soft
  // env response. No emissive lift — it blows out under bloom.
  return new THREE.MeshStandardMaterial({ color: color, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.9 });
}
function rbox(w, h, d, color, r) {
  const rad = r == null ? Math.min(w, h, d) * 0.14 : r;
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, rad), clay(color));
  m.castShadow = true; m.receiveShadow = true; return m;
}
function box(w, h, d, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), clay(color));
  m.castShadow = true; m.receiveShadow = true; return m;
}
function cyl(rt, rb, h, color, seg) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 18), clay(color));
  m.castShadow = true; m.receiveShadow = true; return m;
}
function sphere(r, color) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), clay(color));
  m.castShadow = true; m.receiveShadow = true; return m;
}
function at(obj, x, y, z) { obj.position.set(x, y, z); return obj; }

// ---- procedural textures (no external assets) ----------------------------
function woodTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#cda36a'; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 512; i += 64) {
    x.fillStyle = 'rgba(120,82,42,0.14)'; x.fillRect(i, 0, 2, 512);
    x.fillStyle = 'rgba(255,238,205,0.14)'; x.fillRect(i + 3, 0, 2, 512);
  }
  for (let i = 0; i < 1200; i++) {
    x.fillStyle = 'rgba(120,82,42,' + (Math.random() * 0.04) + ')';
    x.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 26 + 4, 1);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); t.anisotropy = 4; return t;
}
function rugTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = palette[1] || '#C98A5E'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 7; i++) {
    x.strokeStyle = palette[(i + 2) % palette.length] || '#8FA98C';
    x.lineWidth = 6; x.strokeRect(14 + i * 16, 14 + i * 16, 256 - 28 - i * 32, 256 - 28 - i * 32);
  }
  for (let i = 0; i < 256; i += 22) {
    x.fillStyle = palette[2] || '#8FA98C';
    for (let j = 11; j < 256; j += 22) { x.beginPath(); x.moveTo(i, j - 6); x.lineTo(i + 6, j); x.lineTo(i, j + 6); x.lineTo(i - 6, j); x.fill(); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function windowTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#1a2540'); g.addColorStop(0.6, '#2d3a63'); g.addColorStop(1, '#3a4a78');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#202b40';
  for (let i = 0; i < 7; i++) { const w = 26 + Math.random() * 40, h = 50 + Math.random() * 90; x.fillRect(i * 34, 256 - h, w, h); }
  x.fillStyle = 'rgba(255,214,140,0.9)';
  for (let i = 0; i < 40; i++) x.fillRect(Math.random() * 256, 120 + Math.random() * 120, 4, 5);
  x.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 30; i++) x.fillRect(Math.random() * 256, Math.random() * 110, 1.5, 1.5);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function screenTexture(app) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  const x = c.getContext('2d');
  x.fillStyle = '#1d1f29'; x.fillRect(0, 0, 256, 160);
  x.fillStyle = '#0f1118'; x.fillRect(0, 96, 256, 64);          // timeline tray
  const clips = palette.concat(['#5a7bd8', '#e0a44a', '#cf5d6e']);
  let px = 6;
  for (let i = 0; i < 12; i++) { const w = 10 + (hash(app + i) % 30); x.fillStyle = clips[i % clips.length]; x.fillRect(px, 104, w, 18); x.fillRect(px, 126, w * 0.7, 14); px += w + 5; if (px > 250) break; }
  x.fillStyle = '#2c3140'; x.fillRect(20, 14, 216, 70);          // preview
  x.fillStyle = 'rgba(255,255,255,0.9)'; x.font = 'bold 13px sans-serif';
  x.fillText((app || 'Editor').slice(0, 16), 22, 150);
  x.fillStyle = '#ff5d5d'; x.fillRect(96, 96, 2, 64);            // playhead
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---- zone groups ---------------------------------------------------------
const zones = {};
['library', 'content', 'referral', 'style', 'companions'].forEach(function (z) {
  const g = new THREE.Group(); g.name = z; scene.add(g); zones[z] = g;
});
const hotspots = [];
const animators = [];   // idle component animations, advanced each frame (see render loop)
function hotspot(mesh, zone, id, link) {
  mesh.userData = { zone: zone, id: id, link: link || null, hot: true, base: mesh.material.emissive ? mesh.material.emissive.clone() : new THREE.Color(0) };
  mesh.material.emissive = new THREE.Color(0x000000);
  hotspots.push(mesh);
  return mesh;
}

// ===========================================================================
// ROOM SHELL (the fixed skeleton)
// ===========================================================================
// Floor spans x,z in [-5,5]; back wall at z=-5, side wall at x=-5; they meet at
// the far corner (-5,-5) and the cutaway opens toward the camera at (+,+).
const floorMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7, metalness: 0.02 });
const floor = new THREE.Mesh(new RoundedBoxGeometry(10, 0.5, 10, 3, 0.18), floorMat);
floor.position.set(0, -0.25, 0); floor.receiveShadow = true; scene.add(floor);

const backWall = at(rbox(10, 6, 0.4, WALL, 0.12), 0, 3, -5.2); backWall.receiveShadow = true; scene.add(backWall);
const sideWall = at(rbox(0.4, 6, 10, WALL, 0.12), -5.2, 3, 0); sideWall.receiveShadow = true; scene.add(sideWall);
scene.add(at(box(10, 0.3, 0.5, 0xe2d8c6), 0, 0.15, -4.95));     // baseboards
scene.add(at(box(0.5, 0.3, 10, 0xe2d8c6), -4.95, 0.15, 0));

const rug = new THREE.Mesh(new THREE.CircleGeometry(2.7, 40), new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 0.95 }));
rug.rotation.x = -Math.PI / 2; rug.position.set(0.4, 0.02, 0.8); rug.receiveShadow = true; scene.add(rug);
zones.style.add(rug);

// Soft "floating diorama" shadow on the white page, just under the floor box.
const catcher = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.ShadowMaterial({ opacity: 0.16 }));
catcher.rotation.x = -Math.PI / 2; catcher.position.y = -0.52; catcher.receiveShadow = true; scene.add(catcher);

// ===========================================================================
// LIBRARY — back wall: shelves, books, frames, plant, figurines
// ===========================================================================
(function library() {
  const lib = PROFILE.library || {};
  const reads = lib.reads || [], shows = lib.shows || [], roles = lib.roleModels || [], interests = lib.interests || [];
  function shelf(y) { const s = at(rbox(4.6, 0.18, 0.7, 0x9c7850, 0.05), -1.3, y, -4.55); zones.library.add(s); return s; }
  function books(y, list) {
    let x = -3.35;
    list.forEach(function (title, i) {
      const h = 0.5 + (hash(title) % 4) * 0.09, w = 0.17 + (hash(title + 'w') % 3) * 0.05;
      const b = at(box(w, h, 0.5, pick(palette, title)), x + w / 2, y + 0.09 + h / 2, -4.55);
      b.rotation.y = ((hash(title) % 7) - 3) * 0.02;
      zones.library.add(b); x += w + 0.05; if (x > 0.7) { x = -3.35; }
    });
  }
  shelf(3.0); books(3.0, reads.slice(0, 7));
  shelf(4.25); books(4.25, interests.slice(0, 6));

  // framed posters of shows
  shows.slice(0, 2).forEach(function (s, i) {
    const frame = at(rbox(0.95, 1.25, 0.08, 0xfffaf0, 0.04), 0.7 + i * 1.25, 4.55, -4.92);
    const art = at(box(0.78, 1.05, 0.02, pick(palette, s + 'art')), 0.7 + i * 1.25, 4.55, -4.86);
    zones.library.add(frame); zones.library.add(art);
  });

  // a plant on the top shelf
  const pot = at(cyl(0.18, 0.22, 0.32, 0xcf8e6e), -3.0, 4.5, -4.55); zones.library.add(pot);
  [[-3.0, 4.85, -4.5], [-2.78, 4.78, -4.6], [-3.2, 4.72, -4.5]].forEach(function (p) {
    const leaf = at(sphere(0.22, 0x6f9a64), p[0], p[1], p[2]); leaf.scale.set(1, 1.5, 1); zones.library.add(leaf);
  });

  // role-model figurines (a tiny deer-ish token)
  roles.slice(0, 2).forEach(function (r, i) {
    const g = new THREE.Group();
    g.add(at(rbox(0.34, 0.22, 0.16, 0xb9772f, 0.05), 0, 0.16, 0));
    g.add(at(sphere(0.11, 0xc6852f), 0.13, 0.34, 0));
    g.add(at(cyl(0.015, 0.015, 0.18, 0xa9692a, 6), -0.07, 0.12, 0.05));
    g.add(at(cyl(0.015, 0.015, 0.18, 0xa9692a, 6), 0.07, 0.12, -0.05));
    g.position.set(-2.3 + i * 0.8, 3.18, -4.5);
    zones.library.add(g);
  });
})();

// ===========================================================================
// CONTENT SETUP — floor centre/front: table+laptop, tripod+camera, softbox
// ===========================================================================
(function content() {
  const ct = PROFILE.content || {};
  // round table with the editing laptop + a mug
  const tableTop = at(cyl(1.05, 1.05, 0.12, 0xc79a64, 36), -0.4, 1.0, 0.7); zones.content.add(tableTop);
  [[-1.15, -0.05], [0.35, -0.05], [-1.15, 1.45], [0.35, 1.45]].forEach(function (p) {
    zones.content.add(at(cyl(0.06, 0.06, 1.0, 0x9c7850), p[0], 0.5, p[1]));
  });
  // laptop: base + screen showing the editing timeline
  const lapBase = at(rbox(0.74, 0.05, 0.5, 0x2b2f3a, 0.02), -0.3, 1.08, 0.75); zones.content.add(lapBase);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.46), new THREE.MeshStandardMaterial({ map: screenTexture(ct.editingApp || 'Editor'), emissive: 0x222634, emissiveIntensity: 0.5, roughness: 0.4 }));
  const lid = at(rbox(0.78, 0.5, 0.04, 0x23262f, 0.02), -0.3, 1.34, 0.52); lid.rotation.x = -0.32; zones.content.add(lid);
  screen.position.set(-0.3, 1.34, 0.545); screen.rotation.x = -0.32; zones.content.add(screen);
  zones.companions && zones.content.add(at(cyl(0.1, 0.09, 0.16, 0xffffff), 0.2, 1.14, 0.9)); // mug

  // tripod + camera (height scales with the shooter)
  const tall = { iphone: 0.0, webcam: 0.2, mirrorless: 1.0, dslr: 1.15, podcast: 0.7 };
  const lift = 1.2 + (tall[ct.shooter] != null ? tall[ct.shooter] : 0.9);
  const rig = new THREE.Group(); rig.position.set(2.0, 0, 1.7);
  [0, 2.1, 4.2].forEach(function (a) {
    const leg = at(cyl(0.035, 0.05, lift, 0x3a3f4a), Math.cos(a) * 0.35, lift / 2, Math.sin(a) * 0.35);
    leg.rotation.z = Math.cos(a) * 0.18; leg.rotation.x = -Math.sin(a) * 0.18; rig.add(leg);
  });
  rig.add(at(cyl(0.07, 0.07, 0.3, 0x2b2f3a), 0, lift + 0.15, 0));
  const cam = at(rbox(0.5, 0.36, 0.46, 0x23262f, 0.05), 0, lift + 0.42, 0.06); rig.add(cam);
  rig.add(at(cyl(0.13, 0.15, 0.22, 0x15171d), 0, lift + 0.42, 0.34).rotateX(Math.PI / 2)); // lens
  zones.content.add(rig);

  // a small phone tripod up front
  const phoneRig = new THREE.Group(); phoneRig.position.set(0.9, 0, 2.5);
  [0, 2.1, 4.2].forEach(function (a) { const leg = at(cyl(0.02, 0.025, 0.7, 0x3a3f4a), Math.cos(a) * 0.18, 0.35, Math.sin(a) * 0.18); leg.rotation.z = Math.cos(a) * 0.2; leg.rotation.x = -Math.sin(a) * 0.2; phoneRig.add(leg); });
  phoneRig.add(at(rbox(0.22, 0.42, 0.04, 0x111319, 0.02), 0, 0.92, 0));
  zones.content.add(phoneRig);

  // softbox / key light (a tilted glowing panel on a stand)
  const stand = at(cyl(0.04, 0.05, 2.0, 0x2b2f3a), 3.0, 1.0, 0.4); zones.content.add(stand);
  const sbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 0.7, roughness: 0.5 });
  const softbox = new THREE.Mesh(new RoundedBoxGeometry(0.95, 1.15, 0.18, 3, 0.08), sbMat);
  softbox.position.set(3.0, 2.1, 0.4); softbox.rotation.y = -0.7; softbox.rotation.x = 0.25; softbox.castShadow = true; zones.content.add(softbox);
})();

// ===========================================================================
// REFERRAL — side wall / window: window, speaker & gear-box hotspots
// ===========================================================================
(function referral() {
  const rf = PROFILE.referral || {}; const tech = rf.tech || [], life = rf.lifestyle || [];
  // window on the side wall
  zones.referral.add(at(rbox(0.12, 2.3, 2.7, 0xfffaf0, 0.05), -4.86, 3.7, 1.4));
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.0), new THREE.MeshStandardMaterial({ map: windowTexture(), emissive: 0x33406b, emissiveIntensity: 0.45, roughness: 0.3 }));
  pane.position.set(-4.78, 3.7, 1.4); pane.rotation.y = Math.PI / 2; zones.referral.add(pane);
  zones.referral.add(at(box(0.12, 2.3, 0.08, 0xfffaf0), -4.8, 3.7, 1.4)); // mullion v
  zones.referral.add(at(box(0.12, 0.08, 2.6, 0xfffaf0), -4.8, 3.7, 1.4)); // mullion h

  // low console under the window
  const console_ = at(rbox(0.8, 0.9, 2.0, 0xb98a5c, 0.06), -4.4, 0.45, 1.4); zones.referral.add(console_);

  // speaker / playlist hotspot (lifestyle link)
  const spk = at(rbox(0.5, 0.8, 0.4, 0x2c2f38, 0.05), -4.3, 1.3, 0.7);
  zones.referral.add(spk);
  zones.referral.add(at(cyl(0.16, 0.16, 0.04, 0x111319).rotateZ(Math.PI / 2), -4.07, 1.45, 0.7));
  zones.referral.add(at(cyl(0.1, 0.1, 0.04, 0x111319).rotateZ(Math.PI / 2), -4.07, 1.12, 0.7));
  hotspot(spk, 'referral', 'lifestyle:0', (life[0] && life[0].link) || null);

  // labeled gear box hotspot (tech link)
  const gear = at(rbox(0.7, 0.55, 0.7, pick(palette, 'gearbox'), 0.05), -4.35, 1.18, 2.2);
  zones.referral.add(gear);
  zones.referral.add(at(box(0.55, 0.18, 0.02, 0xfffaf0), -4.0, 1.2, 2.2)); // label
  hotspot(gear, 'referral', 'tech:0', (tech[0] && tech[0].link) || null);
})();

// ===========================================================================
// COMPANIONS — sofa, pet, lamp, props (warmth)
// ===========================================================================
(function companions() {
  const cp = PROFILE.companions || {};
  // sofa against the back-left, facing the open corner
  const sofa = new THREE.Group(); sofa.position.set(-1.9, 0, 1.6); sofa.rotation.y = 0.35;
  sofa.add(at(rbox(2.6, 0.55, 1.1, SOFA, 0.16), 0, 0.55, 0));
  sofa.add(at(rbox(2.6, 0.8, 0.3, SOFA, 0.16), 0, 0.95, -0.5));
  sofa.add(at(rbox(0.3, 0.7, 1.1, SOFA, 0.16), -1.25, 0.8, 0));
  sofa.add(at(rbox(0.3, 0.7, 1.1, SOFA, 0.16), 1.25, 0.8, 0));
  sofa.add(at(rbox(0.6, 0.18, 0.6, pick(palette, 'cushion'), 0.1), -0.5, 0.92, 0.05));
  zones.companions.add(sofa);

  // pet
  if (cp.pet === 'cat' || cp.pet === 'dog') {
    const fur = cp.pet === 'cat' ? 0x8d8f96 : 0xc49a6c;
    const pet = new THREE.Group(); pet.position.set(-1.2, 0.95, 1.7);
    const body = at(sphere(0.34, fur), 0, 0, 0); body.scale.set(1.3, 0.7, 0.9); pet.add(body);
    pet.add(at(sphere(0.2, fur), 0.34, 0.06, 0));
    pet.add(at(box(0.05, 0.12, 0.05, fur), 0.3, 0.24, 0.08));     // ears
    pet.add(at(box(0.05, 0.12, 0.05, fur), 0.4, 0.24, -0.08));
    const tail = at(cyl(0.04, 0.05, 0.5, fur), -0.36, 0.05, 0); tail.rotation.z = 1.1; pet.add(tail);
    zones.companions.add(pet);
  }

  // paper-lantern floor lamp + a warm point light (cozy glow)
  zones.companions.add(at(cyl(0.03, 0.04, 2.6, 0x6f7682), 2.7, 1.3, 2.7));
  const lantern = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 2), new THREE.MeshStandardMaterial({ color: 0xfff4e2, emissive: L.lantern, emissiveIntensity: 0.85, roughness: 0.6 }));
  lantern.position.set(2.7, 2.7, 2.7); zones.companions.add(lantern);
  const glow = new THREE.PointLight(L.lantern, reduced ? 6 : 9, 9, 2); glow.position.set(2.7, 2.7, 2.7); zones.companions.add(glow);

  // pendant lamp over the table
  zones.companions.add(at(cyl(0.01, 0.01, 1.4, 0x6f7682), -0.4, 3.6, 0.7));
  const pendant = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff0d6, emissiveIntensity: 0.7, roughness: 0.5, side: THREE.DoubleSide }));
  pendant.position.set(-0.4, 2.9, 0.7); zones.companions.add(pendant);

  // headphones token on the table
  const hp = new THREE.Group(); hp.position.set(-0.85, 1.1, 0.55);
  hp.add(at(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 10, 24, Math.PI), clay(0x2c2f38)), 0, 0.12, 0).rotateZ(Math.PI));
  hp.add(at(sphere(0.07, 0x2c2f38), -0.16, 0.02, 0)); hp.add(at(sphere(0.07, 0x2c2f38), 0.16, 0.02, 0));
  zones.companions.add(hp);
})();

// ===========================================================================
// AVATAR — the creator, seated and filming (the room's heartbeat). The chair is
// built once; the *person* swaps via the on-screen variant cycler so you can pick
// a look. This is the first slice of the combinatorial kit (avatars x props).
// ===========================================================================
(function avatarRig() {
  const chairCol = 0x8a5a3c, wood = 0x6f4a30;
  const rig = new THREE.Group(); rig.position.set(2.5, 0, 0.15); rig.rotation.y = -0.62; scene.add(rig);

  // reclined lounge chair (matches the reference pose)
  rig.add(at(rbox(0.86, 0.14, 0.82, chairCol, 0.12), 0, 0.92, 0));            // seat
  const back = at(rbox(0.86, 0.98, 0.16, chairCol, 0.12), 0, 1.46, -0.36); back.rotation.x = -0.14; rig.add(back);
  rig.add(at(rbox(0.14, 0.4, 0.66, chairCol, 0.06), -0.48, 1.14, 0));         // armrests
  rig.add(at(rbox(0.14, 0.4, 0.66, chairCol, 0.06),  0.48, 1.14, 0));
  [[-0.34, -0.32], [0.34, -0.32], [-0.34, 0.3], [0.34, 0.3]].forEach(function (p) {
    rig.add(at(cyl(0.045, 0.055, 0.92, wood), p[0], 0.46, p[1]));             // legs
  });

  // pickable looks (skin / hair / shirt). First one matches the reference render.
  const LOOKS = [
    { skin: 0xd7a07a, hair: 0x2b211b, shirt: 0xb06a4f },
    { skin: 0xf2cda6, hair: 0x4a2f1c, shirt: 0x6f8f7a },
    { skin: 0x8a5836, hair: 0x141414, shirt: 0x44639a },
    { skin: 0xe7b58f, hair: 0x6b4a2a, shirt: 0xcaa24a },
  ];

  function person(look) {
    const g = new THREE.Group();
    const dark = 0x2c2f38;
    g.add(at(rbox(0.6, 0.34, 0.56, look.shirt, 0.16), 0, 1.14, 0.06));        // hips
    g.add(at(rbox(0.22, 0.2, 0.6, look.shirt, 0.09), -0.15, 1.02, 0.34));     // thighs
    g.add(at(rbox(0.22, 0.2, 0.6, look.shirt, 0.09),  0.15, 1.02, 0.34));
    g.add(at(rbox(0.2, 0.78, 0.2, 0x3a3f4a, 0.07), -0.15, 0.55, 0.6));        // shins
    g.add(at(rbox(0.2, 0.78, 0.2, 0x3a3f4a, 0.07),  0.15, 0.55, 0.6));
    g.add(at(rbox(0.22, 0.12, 0.32, 0x23262f, 0.05), -0.15, 0.18, 0.74));     // shoes
    g.add(at(rbox(0.22, 0.12, 0.32, 0x23262f, 0.05),  0.15, 0.18, 0.74));
    const torso = at(rbox(0.6, 0.66, 0.42, look.shirt, 0.18), 0, 1.6, 0.02); torso.rotation.x = 0.08; g.add(torso);
    g.add(at(cyl(0.09, 0.11, 0.13, look.skin), 0, 1.92, 0.05));               // neck
    const head = at(sphere(0.26, look.skin), 0, 2.13, 0.07); head.scale.set(1, 1.07, 0.98); g.add(head);
    const cap = at(sphere(0.285, look.hair), 0, 2.19, 0.03); cap.scale.set(1.06, 0.92, 1.08); g.add(cap);
    g.add(at(rbox(0.5, 0.22, 0.42, look.hair, 0.1), 0, 2.18, -0.07));         // back hair
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 10, 24, Math.PI), clay(dark));
    band.position.set(0, 2.2, 0.04); g.add(band);                            // headphone arc
    g.add(at(cyl(0.095, 0.095, 0.07, dark), -0.28, 2.06, 0.05).rotateZ(Math.PI / 2)); // ear cups
    g.add(at(cyl(0.095, 0.095, 0.07, dark),  0.28, 2.06, 0.05).rotateZ(Math.PI / 2));
    g.add(at(rbox(0.18, 0.46, 0.2, look.shirt, 0.08), -0.34, 1.6, 0.06));     // upper arms
    g.add(at(rbox(0.18, 0.46, 0.2, look.shirt, 0.08),  0.34, 1.6, 0.06));
    const hands = new THREE.Group();                                          // forearms + hands (typing)
    hands.add(at(cyl(0.075, 0.085, 0.42, look.skin, 12), -0.26, 1.4, 0.34).rotateX(Math.PI / 2 - 0.35));
    hands.add(at(cyl(0.075, 0.085, 0.42, look.skin, 12),  0.26, 1.4, 0.34).rotateX(Math.PI / 2 - 0.35));
    hands.add(at(sphere(0.09, look.skin), -0.2, 1.3, 0.56));
    hands.add(at(sphere(0.09, look.skin),  0.2, 1.3, 0.56));
    g.add(hands);
    g.add(at(rbox(0.52, 0.04, 0.34, 0x2b2f3a, 0.02), 0, 1.26, 0.5));          // laptop base
    const lap = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32),
      new THREE.MeshStandardMaterial({ map: screenTexture('Editing'), emissive: 0x20242f, emissiveIntensity: 0.5, roughness: 0.4 }));
    lap.position.set(0, 1.46, 0.36); lap.rotation.x = -0.5; g.add(lap);       // laptop screen
    return { group: g, torso: torso, head: head, hands: hands, headY: head.position.y, handsY: hands.position.y };
  }

  let AV = null;
  let idx = hash(((PROFILE.creator && PROFILE.creator.name) || 'Creator') + 'avatar') % LOOKS.length;
  function setAvatar(i) {
    idx = ((i % LOOKS.length) + LOOKS.length) % LOOKS.length;
    if (AV) rig.remove(AV.group);
    AV = person(LOOKS[idx]);
    rig.add(AV.group);
    const lbl = document.getElementById('pickLabel'); if (lbl) lbl.textContent = 'Avatar ' + (idx + 1);
  }
  setAvatar(idx);

  const prev = document.getElementById('prev'), next = document.getElementById('next');
  if (prev) prev.addEventListener('click', function () { setAvatar(idx - 1); });
  if (next) next.addEventListener('click', function () { setAvatar(idx + 1); });

  animators.push(function (t) {                                               // breathing + idle typing
    if (!AV) return;
    AV.torso.scale.y = 1 + Math.sin(t * 1.5) * 0.013;
    AV.head.position.y = AV.headY + Math.sin(t * 1.5 + 0.5) * 0.008;
    AV.hands.position.y = AV.handsY + Math.sin(t * 8.0) * 0.005;
  });
})();

// ===========================================================================
// RAINEY — the signature reindeer figurine on the back-wall shelf (the mascot).
// Soft glowing nose, slow look-around.
// ===========================================================================
(function rainey() {
  const brown = 0x9c6a3a, dark = 0x6f4a28;
  const g = new THREE.Group(); g.position.set(0.55, 4.36, -4.5); g.scale.setScalar(0.9);
  g.add(at(rbox(0.34, 0.22, 0.18, brown, 0.07), 0, 0.18, 0));                 // body
  const neck = at(rbox(0.12, 0.2, 0.12, brown, 0.05), 0.13, 0.3, 0); neck.rotation.z = -0.4; g.add(neck);
  const head = at(sphere(0.1, brown), 0.22, 0.4, 0); head.scale.set(1.1, 0.9, 0.9); g.add(head);
  g.add(at(sphere(0.05, dark), 0.31, 0.37, 0));                              // snout
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff6a4a, emissive: 0xff5a3a, emissiveIntensity: 1.2, roughness: 0.5 });
  g.add(at(new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 1), noseMat), 0.35, 0.37, 0)); // glowing nose
  g.add(at(rbox(0.03, 0.06, 0.02, brown, 0.01), 0.2, 0.49, 0.06));            // ears
  g.add(at(rbox(0.03, 0.06, 0.02, brown, 0.01), 0.2, 0.49, -0.06));
  [0.05, -0.05].forEach(function (z) {                                        // antlers
    const a = at(cyl(0.008, 0.012, 0.14, dark, 6), 0.18, 0.52, z); a.rotation.z = -0.3; g.add(a);
    const b = at(cyl(0.006, 0.008, 0.07, dark, 6), 0.13, 0.6, z); b.rotation.z = 0.5; g.add(b);
  });
  [[-0.1, 0.06], [-0.1, -0.06], [0.1, 0.06], [0.1, -0.06]].forEach(function (p) {
    g.add(at(cyl(0.018, 0.022, 0.18, dark, 6), p[0], 0.06, p[1]));            // legs
  });
  zones.library.add(g);
  animators.push(function (t) {
    noseMat.emissiveIntensity = 1.0 + Math.sin(t * 2.2) * 0.5;
    g.rotation.y = Math.sin(t * 0.5) * 0.06;
  });
})();

// ---- hotspot interaction -------------------------------------------------
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let hovered = null;
function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}
function pickHotspot() { ray.setFromCamera(ptr, camera); const hits = ray.intersectObjects(hotspots, false); return hits.length ? hits[0].object : null; }
canvas.addEventListener('pointermove', function (e) {
  setPointer(e);
  const hit = pickHotspot();
  if (hit !== hovered) {
    if (hovered) { hovered.material.emissive.setHex(0x000000); hovered.scale.multiplyScalar(1 / 1.06); }
    hovered = hit;
    if (hovered) { hovered.material.emissive.setHex(0x3a2c12); hovered.scale.multiplyScalar(1.06); }
    canvas.classList.toggle('point', !!hovered);
  }
});
canvas.addEventListener('click', function (e) {
  setPointer(e);
  const hit = pickHotspot();
  if (hit && hit.userData && hit.userData.link) {
    parent.postMessage({ source: 'rainy-room', type: 'hotspot', link: hit.userData.link, id: hit.userData.id, zone: hit.userData.zone }, '*');
  }
});

// ---- clay post-processing: AO -> bloom -> SMAA -> AgX --------------------
// Ambient occlusion (GTAO) is the single biggest clay contributor — it deepens
// the soft contact darkening in every crease. Bloom blooms the warm lamps; SMAA
// re-adds the antialiasing that post-processing disables; OutputPass tone-maps.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.output = GTAOPass.OUTPUT.Default;
gtao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.0, thickness: 1.0, scale: 1.0, samples: 16, screenSpaceRadius: false });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
gtao.blendIntensity = 1.0;
composer.addPass(gtao);

// Very subtle — only the actual lamp/emissive cores should bloom, not the walls.
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.16, 0.6, 0.92);
composer.addPass(bloom);

composer.addPass(new SMAAPass(innerWidth, innerHeight));
composer.addPass(new OutputPass());

// ---- resize + render loop ------------------------------------------------
function resize() {
  const w = innerWidth, h = innerHeight, a = w / h;
  camera.left = -FRUST * a; camera.right = FRUST * a; camera.top = FRUST; camera.bottom = -FRUST;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
}
addEventListener('resize', resize); resize();

document.getElementById('label').textContent =
  ((PROFILE.creator && PROFILE.creator.name) || 'Creator') + "'s room";

const clock = new THREE.Clock();
renderer.setAnimationLoop(function () {
  const t = clock.getElapsedTime();
  if (!reduced) { for (let i = 0; i < animators.length; i++) animators[i](t); }
  controls.update();
  composer.render();
});

// tell the host we're alive (lets it hide its loading state)
parent.postMessage({ source: 'rainy-room', type: 'ready' }, '*');
</script>
</body>
</html>`
