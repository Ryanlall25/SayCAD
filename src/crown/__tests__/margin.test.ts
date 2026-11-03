import { describe, expect, it } from 'vitest'
import { SurfaceIndex, dot } from '../geom'
import { detectMargin, marginError, marginFromTaps } from '../margin'
import { mirrorToUpper, syntheticMolarCase } from '../synthetic'

describe('margin detection (synthetic #19 chamfer prep)', () => {
  const c = syntheticMolarCase()
  const scan = new SurfaceIndex(c.prep)

  it('finds the finish line within scanner resolution from one tap', () => {
    const t0 = performance.now()
    const m = detectMargin(scan, c.tapPoint)
    const ms = performance.now() - t0
    const err = marginError(m.points, c.margin)
    console.log('margin error', err, 'missing', m.missingFraction, 'ms', ms.toFixed(0))
    expect(m.points.length).toBe(180)
    expect(err.mean).toBeLessThan(0.08)
    expect(err.p95).toBeLessThan(0.15)
    expect(dot(m.axis.up, c.axis)).toBeGreaterThan(Math.cos((3 * Math.PI) / 180))
  })

  it('works the same on an upper (mirrored) arch', () => {
    const u = mirrorToUpper(c)
    const m = detectMargin(new SurfaceIndex(u.prep), u.tapPoint)
    const err = marginError(m.points, u.margin)
    expect(err.mean).toBeLessThan(0.08)
    expect(dot(m.axis.up, u.axis)).toBeGreaterThan(0.99)
  })
})

describe('finish-line variants', () => {
  it('finds shoulder margins, and chamfers with the gingiva 0.15 mm away', () => {
    for (const opts of [{ finish: 'shoulder' as const }, { marginAboveGumMm: 0.15 }]) {
      const c = syntheticMolarCase(opts)
      const m = detectMargin(new SurfaceIndex(c.prep), c.tapPoint)
      expect(marginError(m.points, c.margin).mean).toBeLessThan(0.08)
    }
  })

  it('says so instead of guessing when it cannot see a feather edge', () => {
    const c = syntheticMolarCase({ finish: 'featherEdge' })
    const scan = new SurfaceIndex(c.prep)
    const m = detectMargin(scan, c.tapPoint)
    if (m.points.length) {
      // A returned loop is flagged for review everywhere, and is either right
      // or labelled as traced at the gum line (where this scan's prep ends).
      expect(Math.max(...m.confidence)).toBeLessThan(0.35)
      if (!m.gumLine) expect(marginError(m.points, c.margin).mean).toBeLessThan(0.2)
    }
    // The manual route: a handful of taps on the true margin, in any order.
    const taps = [0, 40, 75, 110, 150, 185, 220, 260, 300, 330].map((k) => c.margin[(k * 7) % 360])
    const drawn = marginFromTaps(scan, taps)
    expect(drawn.points.length).toBe(180)
    expect(marginError(drawn.points, c.margin).mean).toBeLessThan(0.12)
    expect(dot(drawn.axis.up, c.axis)).toBeGreaterThan(0.97)
  })

  it('takes the occlusal side from a hint over the scan test (die set in a model jaw)', () => {
    const c = syntheticMolarCase()
    const scan = new SurfaceIndex(c.prep)
    const taps = [0, 60, 120, 180, 240, 300].map((k) => c.margin[k])
    const mid = taps.reduce((a, p) => [a[0] + p[0] / 6, a[1] + p[1] / 6, a[2] + p[2] / 6], [0, 0, 0])
    const at = (s: number): [number, number, number] => [mid[0] + c.axis[0] * s, mid[1] + c.axis[1] * s, mid[2] + c.axis[2] * s]
    expect(dot(marginFromTaps(scan, taps, 180, { above: at(4) }).axis.up, c.axis)).toBeGreaterThan(0.97)
    // A hint on the other side wins: it is what the caller knows (the crown, the opposing arch).
    expect(dot(marginFromTaps(scan, taps, 180, { above: at(-4) }).axis.up, c.axis)).toBeLessThan(-0.97)
  })
})
