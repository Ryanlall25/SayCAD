import { describe, expect, it } from 'vitest'
import { occlusalRelief } from '../donors'
import type { CrownGrid } from '../grid'

const grid = (height: (i: number, j: number) => number): CrownGrid => {
  const nu = 32, nv = 20
  const pts: number[] = []
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) pts.push(Math.cos((2 * Math.PI * i) / nu), height(i, j), Math.sin((2 * Math.PI * i) / nu))
  return { nu, nv, pts, pole: [0, 6, 0] } as unknown as CrownGrid
}

describe('occlusal relief (donor choice)', () => {
  it('reads cusp-to-fossa height over the top rows only', () => {
    // Flat table: no relief, whatever the walls do below.
    expect(occlusalRelief(grid((i, j) => (j < 14 ? j * 0.2 : 5)))).toBeCloseTo(0, 6)
    // Four cusps 1.5 mm over the fossae.
    const cusps = occlusalRelief(grid((i, j) => (j < 14 ? j * 0.2 : 5 + 0.75 * (1 + Math.cos((4 * 2 * Math.PI * i) / 32)))))
    expect(cusps).toBeGreaterThan(1.3)
    expect(cusps).toBeLessThanOrEqual(1.5 + 1e-9)
  })
})
