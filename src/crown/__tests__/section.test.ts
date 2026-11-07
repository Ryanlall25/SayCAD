import { describe, expect, it } from 'vitest'
import { autoDesign, prepareCase } from '../pipeline'
import { syntheticMolarCase } from '../synthetic'
import { readSection, sliceMesh, type SectionPlane } from '../section'
import type { Vec3 } from '../geom'

const c = syntheticMolarCase()
const r = autoDesign(prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist }), { tap: c.tapPoint })
const pos = r.crown.getAttribute('position').array as ArrayLike<number>
const idx = r.crown.index!.array as ArrayLike<number>
const nOuter = r.outer.grid.nu * r.outer.grid.nv + 1
const outerTris: number[] = []
const innerTris: number[] = []
for (let t = 0; t < idx.length; t += 3) (Math.max(idx[t], idx[t + 1], idx[t + 2]) < nOuter ? outerTris : innerTris).push(idx[t], idx[t + 1], idx[t + 2])
const f = r.frame
const plane = (normal: Vec3, xAxis: Vec3): SectionPlane => ({ point: f.origin, normal, xAxis, yAxis: f.occlusal })

describe('cross-sections', () => {
  it('cuts the crown into closed outer and intaglio outlines, centred on the tooth', () => {
    const p = plane(f.mesial, f.buccal)
    const outer = sliceMesh(pos, outerTris, p)
    const inner = sliceMesh(pos, innerTris, p)
    expect(outer.length / 4).toBeGreaterThan(40)
    expect(inner.length / 4).toBeGreaterThan(20)
    // Buccolingual section: the outline spans both sides of the axis.
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < outer.length; k += 2) { lo = Math.min(lo, outer[k]); hi = Math.max(hi, outer[k]) }
    expect(lo).toBeLessThan(-3)
    expect(hi).toBeGreaterThan(3)
  })

  it('reads the thinnest wall no thinner than the design checks allow, and the bite gap', () => {
    const p = plane(f.mesial, f.buccal)
    const reading = readSection(sliceMesh(pos, outerTris, p), sliceMesh(pos, innerTris, p), sliceMesh(c.antagonist.getAttribute('position').array as ArrayLike<number>, c.antagonist.index ? (c.antagonist.index.array as ArrayLike<number>) : null, p))
    expect(reading.minThicknessMm).not.toBeNull()
    // The crown passed its thickness checks (≥ 0.5 mm, 0.4 locally); a slice can't find less.
    expect(reading.minThicknessMm!).toBeGreaterThan(0.38)
    expect(reading.minThicknessMm!).toBeLessThan(2.5)
    expect(reading.biteGapMm).not.toBeNull()
    expect(reading.biteGapMm!).toBeLessThan(1.5)
  })

  it('finds nothing when the plane misses the crown', () => {
    const far: SectionPlane = { point: [f.origin[0] + 50 * f.mesial[0], f.origin[1] + 50 * f.mesial[1], f.origin[2] + 50 * f.mesial[2]], normal: f.mesial, xAxis: f.buccal, yAxis: f.occlusal }
    expect(sliceMesh(pos, outerTris, far).length).toBe(0)
    expect(readSection(new Float64Array(), new Float64Array(), null).minThicknessMm).toBeNull()
  })
})
