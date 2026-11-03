/**
 * Lab cases on disk for dev scripts (git-ignored dev/cases/<set>/caseNN/):
 * prep_jaw.* (+ prep_die.* from exocad Model Creator), opposing_jaw.*,
 * crown_exocad.stl (the technician's crown) and case.json
 * ({ fdi_tooth, margin_points }).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { parseScan } from '../../src/core/meshConvert'
import { SurfaceIndex, type Vec3 } from '../../src/crown/geom'

export interface LabCase {
  id: string
  dir: string
  fdi: number
  margin: Vec3[]
  /** Prep arch with the die set in, as a scan input. */
  prep: { name: string; mesh: { positions: Float32Array; indices: Uint32Array } }
  prepGeometry: THREE.BufferGeometry
  antagonist: { name: string; data: ArrayBuffer } | null
  crown: THREE.BufferGeometry
}

export const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const find = (dir: string, stem: string): string | undefined => readdirSync(dir).find((x) => x.startsWith(stem + '.'))

export function listCases(root: string): string[] {
  return readdirSync(root).filter((d) => /^case\d+$/.test(d) && existsSync(join(root, d, 'case.json'))).sort()
}

export function loadLabCase(root: string, id: string): LabCase {
  const dir = join(root, id)
  const info = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as { fdi_tooth: number; margin_points: Vec3[] }
  const jawF = find(dir, 'prep_jaw')
  if (!jawF) throw new Error(`${dir}: no prep_jaw.*`)
  const jaw = parseScan(jawF, ab(readFileSync(join(dir, jawF))))
  const dieF = find(dir, 'prep_die')
  const pos: number[] = []
  const idx: number[] = []
  const add = (g: THREE.BufferGeometry, keep: (c: Vec3) => boolean): void => {
    const p = g.getAttribute('position')
    const ix = g.index!
    const base = pos.length / 3
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i))
    for (let t = 0; t < ix.count; t += 3) {
      const a = ix.getX(t), b = ix.getX(t + 1), c = ix.getX(t + 2)
      const cen: Vec3 = [(p.getX(a) + p.getX(b) + p.getX(c)) / 3, (p.getY(a) + p.getY(b) + p.getY(c)) / 3, (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3]
      if (keep(cen)) idx.push(base + a, base + b, base + c)
    }
  }
  if (dieF) {
    // exocad Model Creator: the die sits in a socket; drop the jaw's copy of that area.
    const die = parseScan(dieF, ab(readFileSync(join(dir, dieF))))
    const near = new SurfaceIndex(die)
    add(jaw, (c) => !near.closest(c, 1.2))
    add(die, () => true)
  } else add(jaw, () => true)
  const positions = Float32Array.from(pos)
  const indices = Uint32Array.from(idx)
  const prepGeometry = new THREE.BufferGeometry()
  prepGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  prepGeometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const oppF = find(dir, 'opposing_jaw')
  return {
    id,
    dir,
    fdi: info.fdi_tooth,
    margin: info.margin_points,
    prep: { name: dieF ? `${jawF}+${dieF}` : jawF, mesh: { positions, indices } },
    prepGeometry,
    antagonist: oppF ? { name: oppF, data: ab(readFileSync(join(dir, oppF))) } : null,
    crown: new STLLoader().parse(ab(readFileSync(join(dir, 'crown_exocad.stl'))))
  }
}
