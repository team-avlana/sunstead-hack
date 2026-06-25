/**
 * iOS-style squircle (continuous corner) path generator.
 *
 * Straight edges with smoothly-ramped corners — the same superellipse-ish
 * corner Apple uses on iOS, not a plain circular `border-radius`. Ported from
 * the figma-squircle corner math (Figma's "corner smoothing"), specialised to
 * the equal-corners case we need for canvas frames.
 *
 * `smoothing` 0 → a plain circular rounded rect; ~0.6 ≈ the iOS look.
 */

const toRadians = (deg: number) => (deg * Math.PI) / 180

interface CornerPathParams {
  a: number
  b: number
  c: number
  d: number
  p: number
  arcSectionLength: number
  cornerRadius: number
}

function getPathParamsForCorner(
  cornerRadius: number,
  cornerSmoothing: number,
  roundingAndSmoothingBudget: number
): CornerPathParams {
  let p = (1 + cornerSmoothing) * cornerRadius

  // Clamp smoothing/length so the corner never overruns the available edge.
  const maxCornerSmoothing = roundingAndSmoothingBudget / cornerRadius - 1
  cornerSmoothing = Math.min(cornerSmoothing, maxCornerSmoothing)
  p = Math.min(p, roundingAndSmoothingBudget)

  const arcMeasure = 90 * (1 - cornerSmoothing)
  const arcSectionLength = Math.sin(toRadians(arcMeasure / 2)) * cornerRadius * Math.SQRT2

  const angleAlpha = (90 - arcMeasure) / 2
  const p3ToP4Distance = cornerRadius * Math.tan(toRadians(angleAlpha / 2))

  const angleBeta = 45 * cornerSmoothing
  const c = p3ToP4Distance * Math.cos(toRadians(angleBeta))
  const d = c * Math.tan(toRadians(angleBeta))

  const b = (p - arcSectionLength - c - d) / 3
  const a = 2 * b

  return { a, b, c, d, p, arcSectionLength, cornerRadius }
}

function rounded(strings: TemplateStringsArray, ...values: number[]): string {
  return strings.reduce((acc, str, i) => {
    const value = values[i]
    return acc + str + (typeof value === 'number' ? value.toFixed(4) : '')
  }, '')
}

function drawTopRightPath({ cornerRadius, a, b, c, d, arcSectionLength }: CornerPathParams) {
  return rounded`
    c ${a} 0 ${a + b} 0 ${a + b + c} ${d}
    a ${cornerRadius} ${cornerRadius} 0 0 1 ${arcSectionLength} ${arcSectionLength}
    c ${d} ${c} ${d} ${b + c} ${d} ${a + b + c}`
}

function drawBottomRightPath({ cornerRadius, a, b, c, d, arcSectionLength }: CornerPathParams) {
  return rounded`
    c 0 ${a} 0 ${a + b} ${-d} ${a + b + c}
    a ${cornerRadius} ${cornerRadius} 0 0 1 -${arcSectionLength} ${arcSectionLength}
    c ${-c} ${d} ${-(b + c)} ${d} ${-(a + b + c)} ${d}`
}

function drawBottomLeftPath({ cornerRadius, a, b, c, d, arcSectionLength }: CornerPathParams) {
  return rounded`
    c ${-a} 0 ${-(a + b)} 0 ${-(a + b + c)} ${-d}
    a ${cornerRadius} ${cornerRadius} 0 0 1 -${arcSectionLength} -${arcSectionLength}
    c ${-d} ${-c} ${-d} ${-(b + c)} ${-d} ${-(a + b + c)}`
}

function drawTopLeftPath({ cornerRadius, a, b, c, d, arcSectionLength }: CornerPathParams) {
  return rounded`
    c 0 ${-a} 0 ${-(a + b)} ${d} ${-(a + b + c)}
    a ${cornerRadius} ${cornerRadius} 0 0 1 ${arcSectionLength} -${arcSectionLength}
    c ${c} ${-d} ${b + c} ${-d} ${a + b + c} ${-d}`
}

/**
 * Build an SVG path string for a `width`×`height` squircle with equal corners.
 * The corner radius is clamped to half the shortest side.
 */
export function getSquirclePath(width: number, height: number, radius: number, smoothing = 0.6): string {
  const budget = Math.max(0, Math.min(width, height) / 2)
  const cornerRadius = Math.max(0, Math.min(radius, budget))
  if (cornerRadius === 0 || budget === 0) {
    return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`
  }

  const params = getPathParamsForCorner(cornerRadius, smoothing, budget)
  const { p } = params

  return `
    M ${(width - p).toFixed(4)} 0
    ${drawTopRightPath(params)}
    L ${width.toFixed(4)} ${(height - p).toFixed(4)}
    ${drawBottomRightPath(params)}
    L ${p.toFixed(4)} ${height.toFixed(4)}
    ${drawBottomLeftPath(params)}
    L 0 ${p.toFixed(4)}
    ${drawTopLeftPath(params)}
    Z
  `
    .replace(/[\t\s\n]+/g, ' ')
    .trim()
}
