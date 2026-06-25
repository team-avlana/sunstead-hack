'use client'

/**
 * Progressive ("gradient") backdrop blur for the top of the canvas, behind the
 * project header. A single `backdrop-filter` can only do one uniform blur, so we
 * stack several masked layers: each layer blurs a little more and is masked to a
 * band that slides upward. The result is 0px blur at the bottom edge ramping up
 * to MAX_BLUR at the very top.
 */
const LAYERS = 8
const MAX_BLUR = 4 // px at the top edge

export default function TopBlur() {
  return (
    <div className="rainy-top-blur" aria-hidden>
      {Array.from({ length: LAYERS }, (_, i) => {
        const blur = ((i + 1) / LAYERS) * MAX_BLUR
        // Sliding window mask (to top → 0% is the bottom edge). Lower-blur layers
        // sit near the bottom; higher-blur layers slide toward the top.
        const p = (n: number) => `${((i + n) / LAYERS) * 100}%`
        const mask = `linear-gradient(to top, transparent ${p(0)}, #000 ${p(
          0.5,
        )}, #000 ${p(1.5)}, transparent ${p(2)})`
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              inset: 0,
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        )
      })}
    </div>
  )
}
