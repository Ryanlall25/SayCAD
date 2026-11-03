import { describe, expect, it } from 'vitest'
import { heightMap } from '../design'

describe('crown height change goes into the walls', () => {
  it('reaches the new height and keeps the top 2 mm (cusps to fossae) at true scale', () => {
    for (const sy of [0.73, 0.9, 1.2]) {
      const f = heightMap(7, sy)
      expect(f(0)).toBeCloseTo(0, 6)
      expect(f(7)).toBeCloseTo(7 * sy, 3)
      // Occlusal relief: a 1.5 mm cusp-to-fossa drop near the top stays 1.5 mm.
      expect(f(7) - f(5.5)).toBeCloseTo(1.5, 3)
      // Monotonic: the wall never folds.
      for (let y = 0; y < 7; y += 0.05) expect(f(y + 0.05)).toBeGreaterThan(f(y))
    }
  })

  it('falls back to a uniform scale on a crown too short to keep its table whole', () => {
    const f = heightMap(2.2, 0.6)
    expect(f(2.2)).toBeCloseTo(1.32, 6)
    expect(f(1)).toBeCloseTo(0.6, 6)
  })
})
