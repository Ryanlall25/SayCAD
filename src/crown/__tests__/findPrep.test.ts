import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { findPrep } from '../findPrep'
import { SurfaceIndex, dist, type Vec3 } from '../geom'
import { mirrorToUpper, syntheticMolarCase } from '../synthetic'
import { marginError } from '../margin'
import { autoDesign, prepareCase } from '../pipeline'

const idx = (g: THREE.BufferGeometry): SurfaceIndex => new SurfaceIndex(g.clone())
/** Distance in the occlusal plane (ignores height): did we land on the stump top? */
const planar = (a: Vec3, b: Vec3, up: Vec3): number => {
  const d: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const h = d[0] * up[0] + d[1] * up[1] + d[2] * up[2]
  return Math.sqrt(Math.max(0, dist(a, b) ** 2 - h * h))
}

describe('findPrep: the prep is the tooth that misses the bite', () => {
  const c = syntheticMolarCase({ resolutionMm: 0.15 })

  it('finds #19 on a lower quadrant, on the stump top', () => {
    const g = findPrep(idx(c.prep), idx(c.antagonist))
    expect(g.reason).toBeUndefined()
    expect(planar(g.point!, c.tapPoint, c.axis)).toBeLessThan(2)
    expect(Math.abs(g.point![1] - c.prepTopY)).toBeLessThan(1)
  })

  it('finds #14 on the mirrored upper case', () => {
    const up = mirrorToUpper(c)
    const g = findPrep(idx(up.prep), idx(up.antagonist))
    expect(planar(g.point!, up.tapPoint, up.axis)).toBeLessThan(2)
  })

  it('does not depend on the scanner coordinate system', () => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(12, -40, 7), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -1.1, 0.4)), new THREE.Vector3(1, 1, 1))
    const tap = new THREE.Vector3(...c.tapPoint).applyMatrix4(m)
    const axis = new THREE.Vector3(...c.axis).transformDirection(m)
    const g = findPrep(idx(c.prep.clone().applyMatrix4(m)), idx(c.antagonist.clone().applyMatrix4(m)))
    expect(planar(g.point!, [tap.x, tap.y, tap.z], [axis.x, axis.y, axis.z])).toBeLessThan(2)
  })

  it('says why when it cannot: no antagonist, or arches not in the bite', () => {
    expect(findPrep(idx(c.prep), null).point).toBeNull()
    const apart = c.antagonist.clone().translate(0, 9, 0)
    const g = findPrep(idx(c.prep), idx(apart))
    expect(g.point).toBeNull()
    expect(g.reason).toContain('bite')
  })

  it('reports nothing on an unprepared arch (antagonist resting on every tooth)', () => {
    // Close the gap over the prep: the antagonist now touches the stump too.
    const closed = syntheticMolarCase({ resolutionMm: 0.15, antagonistGapMm: 0.0 })
    const g = findPrep(idx(closed.prep), idx(closed.antagonist))
    expect(g.point).toBeNull()
  })

  it('replaces the tap: found point → margin → a crown that passes QC', () => {
    const full = syntheticMolarCase()
    const pc = prepareCase({ toothNumber: 19, prep: full.prep, antagonist: full.antagonist })
    const g = findPrep(pc.prepIndex, new SurfaceIndex(pc.antagonist!))
    const r = autoDesign(pc, { tap: g.point! })
    expect(marginError(r.margin.points, full.margin).mean).toBeLessThan(0.1)
    expect(r.report.exportable).toBe(true)
  })
})

describe('tooth number → place on the arch', () => {
  it('maps Universal numbers to side and position from the midline', async () => {
    const { toothSide } = await import('../findPrep')
    expect(toothSide(8)).toEqual({ upper: true, side: 'right', pos: 1 })
    expect(toothSide(1)).toEqual({ upper: true, side: 'right', pos: 8 })
    expect(toothSide(13)).toEqual({ upper: true, side: 'left', pos: 5 })
    expect(toothSide(19)).toEqual({ upper: false, side: 'left', pos: 6 })
    expect(toothSide(30)).toEqual({ upper: false, side: 'right', pos: 6 })
    expect(toothSide(25)).toEqual({ upper: false, side: 'right', pos: 1 })
  })

  it('still finds the synthetic #19 when the order gives the tooth', () => {
    const c = syntheticMolarCase({ resolutionMm: 0.15 })
    const g = findPrep(idx(c.prep), idx(c.antagonist), 19)
    expect(planar(g.point!, c.tapPoint, c.axis)).toBeLessThan(2)
  })
})
