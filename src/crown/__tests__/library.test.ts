import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildTemplate, toothClassOf } from '../anatomy'
import { mesialSign } from '../frame'
import { cross, dot, normalize, scale, toWorld, type ToothFrame, type Vec3 } from '../geom'
import { getP } from '../grid'
import { gridTriangles } from '../solid'
import { analyseLibrary, fdiToUniversal, libraryModels, libraryToothNumber } from '../library'
import { normaliseToReference, surfaceDeviation, synthesise } from '../ssm'
import { gridSurface } from '../pipeline'

/** A stand-in library: textbook crowns laid out on a lower arch, open at the cervical. */
function syntheticLibrary(): Array<{ name: string; toothNumber: number; geometry: THREE.BufferGeometry; frame: ToothFrame }> {
  const out = []
  for (const n of [18, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30, 31]) {
    const fromMid = n <= 24 ? 24 - n : n - 25
    const side = n <= 24 ? 1 : -1
    const a = side * (0.15 + fromMid * 0.19)
    const pos: Vec3 = [40 * Math.sin(a), 0, 40 * Math.cos(a)]
    const u: Vec3 = [0, 1, 0]
    const b = normalize([Math.sin(a), 0, Math.cos(a)])
    const frame: ToothFrame = { origin: pos, occlusal: u, buccal: b, mesial: scale(normalize(cross(u, b)), mesialSign(n)) }
    const g = buildTemplate(toothClassOf(n), { nu: 96, nv: 40 }).grid
    const positions: number[] = []
    for (let j = 0; j < g.nv; j++) for (let i = 0; i < g.nu; i++) positions.push(...toWorld(frame, getP(g, i, j)))
    positions.push(...toWorld(frame, g.pole))
    const idx: number[] = []
    gridTriangles(g.nu, g.nv, 0, g.nu * g.nv, false, idx)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    geo.setIndex(idx)
    // Library STLs are triangle soup; make it so.
    out.push({ name: `tooth_${n}.stl`, toothNumber: n, geometry: geo.toNonIndexed(), frame })
  }
  return out
}

describe('tooth library import', () => {
  it('reads tooth numbers from names, converting FDI', () => {
    expect(fdiToUniversal(16)).toBe(3)
    expect(fdiToUniversal(36)).toBe(19)
    expect(fdiToUniversal(41)).toBe(25)
    expect(libraryToothNumber('Lower_36.stl', 'auto', ['Lower_36.stl', 'Lower_37.stl'])).toBe(19)
    expect(libraryToothNumber('tooth_19.stl', 'universal')).toBe(19)
  })

  it('recovers each tooth’s orientation from the library layout and learns its form', () => {
    const lib = syntheticLibrary()
    const imported = analyseLibrary(lib)
    for (const [k, t] of imported.entries()) {
      expect(t.shape, t.error).not.toBeNull()
      expect(dot(t.frame.occlusal, lib[k].frame.occlusal)).toBeGreaterThan(0.98)
      expect(dot(t.frame.buccal, lib[k].frame.buccal)).toBeGreaterThan(0.95)
      expect(dot(t.frame.mesial, lib[k].frame.mesial)).toBeGreaterThan(0.95)
    }
    const models = libraryModels(imported, 'synthetic library')
    expect(Object.keys(models).sort()).toEqual(['lowerAnterior', 'lowerCanine', 'lowerMolar', 'lowerPremolar'])
    // The learned molar is the library's molar (normalised the same way).
    const ref = normaliseToReference(buildTemplate('lowerMolar', { nu: 128, nv: 56 }).grid, 'lowerMolar')
    // Compare surfaces (points may slide along the surface between samplings).
    const dev = surfaceDeviation(synthesise(models.lowerMolar!), gridSurface(ref), 0.5)
    expect(dev.mean).toBeLessThan(0.08)
    expect(dev.p90).toBeLessThan(0.15)
  })
})
