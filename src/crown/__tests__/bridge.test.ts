import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { designBridge } from '../bridge'
import { type DonorSet } from '../donors'
import { commonAxis, insertionAxis } from '../insertion'
import { autoDesign, prepareCase } from '../pipeline'
import { trainShapeModel } from '../ssm'
import { syntheticMolarCase } from '../synthetic'
import { analyseCase } from '../train'
import { dot, type Vec3 } from '../geom'

describe('three-unit bridge (synthetic: two molar preps, a pontic between)', () => {
  const c = syntheticMolarCase()
  const pc = prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist })
  // Donors: the engine's own designs with varied anatomy (as in donors.test).
  const donors: DonorSet['donors'] = [0.8, 1.0, 1.25].map((cuspScale, k) => {
    const crown = autoDesign(pc, { tap: c.tapPoint, params: { cuspScale, occlusalContacts: false } }).crown
    const a = analyseCase({ id: `syn-${k}`, toothNumber: 19, prep: c.prep, antagonist: c.antagonist, crown })
    if (!a.ok || !a.shape) throw new Error(a.error)
    return { id: `syn-${k}`, tooth: 19, model: trainShapeModel('lowerMolar', [a.shape]), size: a.size }
  })
  const set: DonorSet = { version: 1, cls: 'lowerMolar', donors }
  // The second abutment: the same prep 19 mm along the arch, distally.
  const shift = (v: Vec3): Vec3 => [v[0] - c.mesial[0] * 19, v[1] - c.mesial[1] * 19, v[2] - c.mesial[2] * 19]
  const moved = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const m = g.clone()
    m.translate(-c.mesial[0] * 19, -c.mesial[1] * 19, -c.mesial[2] * 19)
    return m
  }
  const strip = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const m = g.index ? g.toNonIndexed() : g.clone()
    for (const k of Object.keys(m.attributes)) if (k !== 'position') m.deleteAttribute(k)
    return m
  }
  // #37 is missing: each copy's teeth over the gap are levelled to a bare
  // ridge (the first copy distal of its prep, the second mesial of its prep).
  const along = (x: number, y: number, z: number): number => -((x - c.tapPoint[0]) * c.mesial[0] + (y - c.tapPoint[1]) * c.mesial[1] + (z - c.tapPoint[2]) * c.mesial[2])
  const level = (g: THREE.BufferGeometry, keep: (s: number) => boolean): THREE.BufferGeometry => {
    const a = g.getAttribute('position')
    for (let k = 0; k < a.count; k++) if (!keep(along(a.getX(k), a.getY(k), a.getZ(k)))) a.setY(k, Math.min(a.getY(k), 0))
    return g
  }
  const prep = mergeGeometries([level(strip(c.prep), (s) => s < 6), level(strip(moved(c.prep)), (s) => s > 13)])!
  const antagonist = mergeGeometries([strip(c.antagonist), strip(moved(c.antagonist))])!

  it('finds one path of insertion that both preps share', () => {
    const one = insertionAxis(pc.prepWelded, c.margin, c.axis)
    const both = commonAxis(prep, [c.margin, c.margin.map(shift)], c.axis)
    // Two identical, parallel preps share their own path.
    expect(dot(both.axis, one.axis)).toBeGreaterThan(Math.cos((3 * Math.PI) / 180))
    expect(both.perAbutmentMm3).toHaveLength(2)
  })

  it('joins two abutments and a pontic into one sound solid', async () => {
    const r = await designBridge({
      prep,
      antagonist,
      units: [
        { fdi: 36, role: 'abutment', margin: c.margin },
        { fdi: 37, role: 'pontic' },
        { fdi: 38, role: 'abutment', margin: c.margin.map(shift) }
      ],
      donors: { lowerMolar: set }
    })
    expect(r.manifoldOk).toBe(true)
    expect(r.genus).toBe(0)
    expect(r.blockers.filter((b) => !b.startsWith('#'))).toEqual([])
    expect(r.notes.join(' ')).not.toMatch(/loose fragment/)
    expect(r.abutments).toHaveLength(2)
    expect(r.connectors).toHaveLength(2)
    for (const k of r.connectors) expect((Math.PI / 4) * k.widthMm * k.heightMm).toBeGreaterThanOrEqual(k.targetMm2 - 1e-6)
    // Bigger than the two crowns alone: the pontic and connectors are in it.
    const crowns = r.abutments.reduce((v, a) => {
      const s = a.result.solidLocal
      let vol = 0
      for (let t = 0; t < s.indices.length; t += 3) {
        const [i, j, k] = [s.indices[t] * 3, s.indices[t + 1] * 3, s.indices[t + 2] * 3]
        const p = s.positions
        vol += (p[i] * (p[j + 1] * p[k + 2] - p[j + 2] * p[k + 1]) - p[i + 1] * (p[j] * p[k + 2] - p[j + 2] * p[k]) + p[i + 2] * (p[j] * p[k + 1] - p[j + 1] * p[k])) / 6
      }
      return v + Math.abs(vol)
    }, 0)
    expect(r.volumeMm3).toBeGreaterThan(crowns + 50)
  }, 600_000)

  it('designs with textbook anatomy when the lab has no crowns for the class', async () => {
    const r = await designBridge({
      prep,
      antagonist,
      units: [
        { fdi: 36, role: 'abutment', margin: c.margin },
        { fdi: 37, role: 'pontic' },
        { fdi: 38, role: 'abutment', margin: c.margin.map(shift) }
      ],
      donors: {}
    })
    expect(r.manifoldOk).toBe(true)
    expect(r.genus).toBe(0)
    expect(r.notes.join(' ')).toMatch(/textbook anatomy/)
    expect(r.connectors).toHaveLength(2)
  }, 600_000)
})
