/**
 * Shooting conditions for the Home greeting — the "golden hour" gimmick.
 *
 * Everything here is client-only and best-effort: we ask the browser for the
 * user's location, compute sun times locally (no API, no key — a trimmed port of
 * Vladimir Agafonkin's SunCalc, BSD-2), and pull a little shoot-relevant weather
 * from Open-Meteo (free, keyless, CORS-friendly). Location name comes from
 * BigDataCloud's keyless reverse geocoder. If anything is blocked or offline we
 * degrade gracefully — golden hour still works from a cached/fallback location.
 */

import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// Sun position  (trimmed SunCalc — https://github.com/mourner/suncalc, BSD-2)
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180
const DAY_MS = 86400000
const J1970 = 2440588
const J2000 = 2451545
const OBLIQUITY = RAD * 23.4397

const toJulian = (d: Date) => d.valueOf() / DAY_MS - 0.5 + J1970
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS)
const toDays = (d: Date) => toJulian(d) - J2000

const declination = (l: number, b: number) =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l))

const solarMeanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d)

const eclipticLongitude = (m: number) => {
  const c = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m))
  return m + c + RAD * 102.9372 + Math.PI
}

const J0 = 0.0009
const julianCycle = (d: number, lw: number) => Math.round(d - J0 - lw / (2 * Math.PI))
const approxTransit = (ht: number, lw: number, n: number) => J0 + (ht + lw) / (2 * Math.PI) + n
const solarTransitJ = (ds: number, m: number, l: number) =>
  J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l)
const hourAngle = (h: number, phi: number, dec: number) =>
  Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)))

export interface SunTimes {
  sunrise: Date
  sunset: Date
  /** Morning golden hour ends (sun reaches +6°). */
  goldenMorningEnd: Date
  /** Evening golden hour starts (sun descends to +6°). */
  goldenEveningStart: Date
  /** Civil dusk — end of the evening blue hour (sun at -6°). */
  dusk: Date
  /** Civil dawn — start of the morning blue hour (sun at -6°). */
  dawn: Date
}

/** Sun event times for `date` at (lat, lng). NaN dates if the sun never reaches an angle (polar). */
export function getSunTimes(date: Date, lat: number, lng: number): SunTimes {
  const lw = RAD * -lng
  const phi = RAD * lat
  const d = toDays(date)
  const n = julianCycle(d, lw)
  const ds = approxTransit(0, lw, n)
  const m = solarMeanAnomaly(ds)
  const l = eclipticLongitude(m)
  const dec = declination(l, 0)
  const jNoon = solarTransitJ(ds, m, l)

  const setFor = (angleDeg: number) => {
    const w = hourAngle(angleDeg * RAD, phi, dec)
    return solarTransitJ(approxTransit(w, lw, n), m, l)
  }
  const event = (angleDeg: number) => {
    const jSet = setFor(angleDeg)
    const jRise = jNoon - (jSet - jNoon)
    return { rise: fromJulian(jRise), set: fromJulian(jSet) }
  }

  const sun = event(-0.833)
  const golden = event(6)
  const civil = event(-6)
  return {
    sunrise: sun.rise,
    sunset: sun.set,
    goldenMorningEnd: golden.rise,
    goldenEveningStart: golden.set,
    dawn: civil.rise,
    dusk: civil.set,
  }
}

// ---------------------------------------------------------------------------
// Time of day → greeting
// ---------------------------------------------------------------------------

export function greetingFor(date: Date): string {
  const h = date.getHours()
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 17) return 'Good afternoon'
  if (h >= 17 && h < 21) return 'Good evening'
  return 'Good night'
}

const fmtTime = (d: Date) =>
  Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

/** The golden-hour window most relevant right now: morning until midday, then evening. */
export function goldenHourWindow(now: Date, t: SunTimes): { label: string; range: string; window: 'morning' | 'evening' } {
  const useMorning = now < t.goldenMorningEnd
  if (useMorning) {
    return { label: 'Golden hour', range: `${fmtTime(t.sunrise)} – ${fmtTime(t.goldenMorningEnd)}`, window: 'morning' }
  }
  return { label: 'Golden hour', range: `${fmtTime(t.goldenEveningStart)} – ${fmtTime(t.sunset)}`, window: 'evening' }
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number
  lng: number
  /** Human label, e.g. "San Francisco, CA". Filled in once reverse geocode resolves. */
  name: string
  /** False when we fell back to a default because geolocation was blocked/unavailable. */
  precise: boolean
}

// Reasonable default so golden hour still renders if the browser blocks geolocation.
const FALLBACK: GeoPoint = { lat: 37.7749, lng: -122.4194, name: 'San Francisco, CA', precise: false }
const LS_GEO = 'rainy:home:geo'

function loadCachedGeo(): GeoPoint | null {
  try {
    const raw = window.localStorage.getItem(LS_GEO)
    return raw ? (JSON.parse(raw) as GeoPoint) : null
  } catch {
    return null
  }
}
function cacheGeo(g: GeoPoint): void {
  try {
    window.localStorage.setItem(LS_GEO, JSON.stringify(g))
  } catch {
    /* ignore quota */
  }
}

function browserPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('no geolocation'))
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 30 * 60 * 1000,
    })
  })
}

async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
      { signal },
    )
    if (!res.ok) return null
    const j = (await res.json()) as { city?: string; locality?: string; principalSubdivision?: string; countryName?: string }
    const city = j.city || j.locality
    const region = j.principalSubdivision || j.countryName
    return [city, region].filter(Boolean).join(', ') || null
  } catch {
    return null
  }
}

/** Best-effort location: precise (browser) → reverse-geocoded name, else cached, else fallback. */
async function resolveLocation(signal?: AbortSignal): Promise<GeoPoint> {
  try {
    const pos = await browserPosition()
    const { latitude: lat, longitude: lng } = pos.coords
    const name = (await reverseGeocode(lat, lng, signal)) ?? 'Your location'
    const point: GeoPoint = { lat, lng, name, precise: true }
    cacheGeo(point)
    return point
  } catch {
    return loadCachedGeo() ?? FALLBACK
  }
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — keyless, CORS-friendly)
// ---------------------------------------------------------------------------

export interface ShootingWeather {
  tempC: number
  apparentC: number
  /** 0–100 — low cloud = harsh light, high cloud = soft/diffused. */
  cloudCover: number
  windKph: number
  humidity: number
  /** Short condition label derived from the WMO weather code. */
  condition: string
  emoji: string
}

// WMO weather interpretation codes → friendly label + emoji.
function describeWmo(code: number): { condition: string; emoji: string } {
  if (code === 0) return { condition: 'Clear', emoji: '☀️' }
  if (code <= 2) return { condition: 'Partly cloudy', emoji: '⛅' }
  if (code === 3) return { condition: 'Overcast', emoji: '☁️' }
  if (code <= 48) return { condition: 'Fog', emoji: '🌫️' }
  if (code <= 57) return { condition: 'Drizzle', emoji: '🌦️' }
  if (code <= 67) return { condition: 'Rain', emoji: '🌧️' }
  if (code <= 77) return { condition: 'Snow', emoji: '🌨️' }
  if (code <= 82) return { condition: 'Showers', emoji: '🌦️' }
  if (code <= 86) return { condition: 'Snow showers', emoji: '🌨️' }
  return { condition: 'Thunderstorm', emoji: '⛈️' }
}

async function fetchWeather(lat: number, lng: number, signal?: AbortSignal): Promise<ShootingWeather | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,wind_speed_10m,weather_code` +
      `&wind_speed_unit=kmh&timezone=auto`
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const j = (await res.json()) as { current?: Record<string, number> }
    const c = j.current
    if (!c) return null
    const { condition, emoji } = describeWmo(c.weather_code)
    return {
      tempC: Math.round(c.temperature_2m),
      apparentC: Math.round(c.apparent_temperature),
      cloudCover: Math.round(c.cloud_cover),
      windKph: Math.round(c.wind_speed_10m),
      humidity: Math.round(c.relative_humidity_2m),
      condition,
      emoji,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ShootingConditions {
  ready: boolean
  greeting: string
  location: GeoPoint | null
  sun: SunTimes | null
  golden: { label: string; range: string; window: 'morning' | 'evening' } | null
  weather: ShootingWeather | null
}

/**
 * Drives the Home greeting block. Resolves location → sun times → weather after
 * mount (never during render, so SSR markup and the first client paint agree).
 */
export function useShootingConditions(): ShootingConditions {
  const [state, setState] = useState<ShootingConditions>({
    ready: false,
    greeting: 'Hello',
    location: null,
    sun: null,
    golden: null,
    weather: null,
  })

  useEffect(() => {
    const ctrl = new AbortController()
    let cancelled = false

    const now = new Date()
    const greeting = greetingFor(now)

    ;(async () => {
      const location = await resolveLocation(ctrl.signal)
      if (cancelled) return
      const sun = getSunTimes(now, location.lat, location.lng)
      const golden = goldenHourWindow(now, sun)
      // Show sun/greeting immediately; weather can arrive a beat later.
      setState({ ready: true, greeting, location, sun, golden, weather: null })

      const weather = await fetchWeather(location.lat, location.lng, ctrl.signal)
      if (cancelled || !weather) return
      setState((s) => ({ ...s, weather }))
    })()

    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [])

  return state
}
