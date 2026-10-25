import { describe, expect, it } from 'vitest'
import { SurfaceIndex, dot } from '../geom'
import { detectMargin, marginError } from '../margin'
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
