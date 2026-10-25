import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { dot, SurfaceIndex, type Vec3 } from '../geom'
import { detectMargin, marginError } from '../margin'
import { autoDesign, prepareCase } from '../pipeline'
import { syntheticMolarCase } from '../synthetic'

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('robustness: arbitrary scanner coordinates + scanner noise', () => {
  const c = syntheticMolarCase()
  const rand = rng(7)
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  // A tilted, rotated, translated coordinate system, as a scanner might export.
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(12, -40, 7),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, -0.4, 2.2)),
    new THREE.Vector3(1, 1, 1)
  )
  const tf = (p: Vec3): Vec3 => {
    const v = new THREE.Vector3(...p).applyMatrix4(m)
    return [v.x, v.y, v.z]
  }
  const noisy = c.prep.clone().applyMatrix4(m)
  const pos = noisy.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) + 0.015 * gauss(), pos.getY(i) + 0.015 * gauss(), pos.getZ(i) + 0.015 * gauss())
  }
  const ant = c.antagonist.clone().applyMatrix4(m)
  const truth = c.margin.map(tf)
  const axis = new THREE.Vector3(...c.axis).transformDirection(m)

  it('finds the margin and axis in any coordinate system, with 15 µm noise', () => {
    const r = detectMargin(new SurfaceIndex(noisy), tf(c.tapPoint))
    const err = marginError(r.points, truth)
    expect(err.mean).toBeLessThan(0.1)
    expect(dot(r.axis.up, [axis.x, axis.y, axis.z])).toBeGreaterThan(Math.cos((3 * Math.PI) / 180))
  })

  it('designs an exportable crown there too', () => {
    const r = autoDesign(prepareCase({ toothNumber: 19, prep: noisy, antagonist: ant }), { tap: tf(c.tapPoint) })
    const failing = r.report.results.filter((x) => x.verdict === 'fail').map((x) => `${x.label} ${x.measured}`)
    expect(failing).toEqual([])
    expect(r.watertight.watertight).toBe(true)
    const b = new THREE.Vector3(...c.buccal).transformDirection(m)
    expect(dot(r.frame.buccal, [b.x, b.y, b.z])).toBeGreaterThan(0.95)
  })

  it('reports (does not hide) insufficient occlusal reduction', () => {
    const tight = syntheticMolarCase({ antagonistGapMm: 0.35 })
    const r = autoDesign(prepareCase({ toothNumber: 19, prep: tight.prep, antagonist: tight.antagonist }), { tap: tight.tapPoint })
    const occ = r.report.results.find((x) => x.id === 'occlusion')!
    const thick = r.report.results.find((x) => x.id === 'thickness-occlusal')!
    // Thickness wins; the conflict shows up as a high crown, flagged as a failure.
    expect(thick.verdict).toBe('pass')
    expect(occ.verdict).toBe('fail')
    expect(r.report.exportable).toBe(false)
  })
})

describe('insertion axis tilt', () => {
  it('changes the path of insertion and still yields a closed crown', () => {
    const c = syntheticMolarCase()
    const pc = prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist })
    const base = autoDesign(pc, { tap: c.tapPoint })
    const tilted = autoDesign(pc, { margin: base.margin, params: { axisTiltMesialDeg: 8 } })
    const angle = Math.acos(Math.min(1, dot(base.frame.occlusal, tilted.frame.occlusal))) * (180 / Math.PI)
    expect(angle).toBeGreaterThan(7)
    expect(angle).toBeLessThan(9)
    expect(dot(tilted.frame.occlusal, base.frame.mesial)).toBeGreaterThan(0)
    // An 8° lean on a 6° taper creates undercuts on the far wall: they get blocked out.
    expect(tilted.intaglio.maxUndercutMm).toBeGreaterThan(base.intaglio.maxUndercutMm)
    expect(tilted.watertight.watertight).toBe(true)
  })
})
