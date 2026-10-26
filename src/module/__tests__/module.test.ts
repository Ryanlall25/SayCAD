import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { syntheticMolarCase } from '../../crown/synthetic'
import { zip } from '../../core/zip'
import { CONTRACT, validateJob, type CrownJob } from '../contract'
import { designCase } from '../designCase'
import { jobFromBundle, outcomeFiles, outcomeJson } from '../bundle'

const c = syntheticMolarCase()
const mesh = (g: THREE.BufferGeometry) => ({ positions: (g.getAttribute('position').array as Float32Array).slice(), indices: g.index ? (g.index.array as Uint32Array).slice() : null })
const stl = (g: THREE.BufferGeometry): ArrayBuffer => {
  const dv = new STLExporter().parse(new THREE.Mesh(g), { binary: true }) as DataView
  return dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength) as ArrayBuffer
}
const job = (over: Partial<CrownJob> = {}): CrownJob => ({
  contract: CONTRACT,
  jobId: 'j1',
  order: { tooth: 19, material: 'zirconia-hs', caseRef: 'SH-1001' },
  scans: { prep: { name: 'lowerjaw.stl', mesh: mesh(c.prep) }, antagonist: { name: 'upperjaw.stl', mesh: mesh(c.antagonist) } },
  ...over
})

describe('saycad.crown/1 — designCase', () => {
  it('designs a crown with no input but the order and two scans', () => {
    const o = designCase(job())
    expect(o.status).toBe('designed')
    expect(o.prepFoundBy).toBe('bite')
    expect(o.verdict).not.toBe('blocked')
    expect(o.jobId).toBe('j1')
    expect(o.caseRef).toBe('SH-1001')
    expect(o.summary!.minOcclusalThicknessMm).toBeGreaterThanOrEqual(0.7)
    // The STL is a real binary STL of the solid.
    const g = new STLLoader().parse(o.files!.crownStl)
    expect(g.getAttribute('position').count / 3).toBeGreaterThan(5000)
    expect(o.files!.designRecord.margin.length).toBeGreaterThan(100)
    expect(o.files!.crownStlName).toMatch(/^crown_SH-1001_19_zirconia-hs_\d{8}\.stl$/)
    // JSON view is serialisable and drops the bytes.
    expect(() => JSON.stringify(outcomeJson(o))).not.toThrow()
    expect(outcomeFiles(o).map((f) => f.name)).toEqual(['outcome.json', o.files!.crownStlName, 'design-record.json'])
  })

  it('accepts FDI numbering (36 → #19)', () => {
    const o = designCase(job({ order: { tooth: 36, system: 'fdi' } }))
    expect(o.status).toBe('designed')
    expect(o.tooth).toBe(19)
  })

  it('stops with needs-input instead of guessing', () => {
    const noAnt = designCase(job({ scans: { prep: { name: 'lowerjaw.stl', mesh: mesh(c.prep) } } }))
    expect(noAnt.status).toBe('needs-input')
    expect(noAnt.needs![0].kind).toBe('prep-location')
    // The host supplies the point → designed.
    const withTap = designCase(job({ scans: { prep: { name: 'lowerjaw.stl', mesh: mesh(c.prep) } }, options: { tap: c.tapPoint } }))
    expect(withTap.status).toBe('designed')
    expect(withTap.prepFoundBy).toBe('host')
  })

  it('rejects malformed jobs in plain words', () => {
    expect(designCase({ ...job(), contract: 'other/9' as typeof CONTRACT }).status).toBe('failed')
    expect(validateJob({ ...job(), order: { tooth: 40 } })).toEqual(['Tooth 40 is not a Universal number (1–32).'])
    const bridge = designCase(job({ order: { tooth: 19, restoration: 'bridge' as 'crown' } }))
    expect(bridge.status).toBe('needs-input')
    expect(bridge.needs![0].kind).toBe('restoration')
  })

  it('exports with the insertion axis on +Z when asked', () => {
    const o = designCase(job({ options: { alignInsertionToZ: true } }))
    const g = new STLLoader().parse(o.files!.crownStl)
    g.computeBoundingBox()
    const b = g.boundingBox!
    expect(b.max.z).toBeGreaterThan(5) // crown rises along +Z
    expect(b.min.z).toBeGreaterThan(-2) // from about the margin plane
    expect(Math.abs((b.max.x + b.min.x) / 2)).toBeLessThan(2) // centred on the axis
  })
})

describe('case bundles', () => {
  const lower = stl(c.prep)
  const upper = stl(c.antagonist)
  it('builds a job from a scanner zip sorted by name', async () => {
    const z = zip([{ name: 'Smith/Smith-mandibular.stl', data: new Uint8Array(lower) }, { name: 'Smith/Smith-maxillary.stl', data: new Uint8Array(upper) }, { name: '__MACOSX/._x', data: new Uint8Array(3) }])
    const { job: j, problems } = await jobFromBundle([{ name: 'case.zip', data: z.buffer }], { tooth: 19 })
    expect(problems).toEqual([])
    expect(j!.scans.prep.name).toBe('Smith-mandibular.stl')
    expect(j!.scans.antagonist!.name).toBe('Smith-maxillary.stl')
    expect(designCase(j!).status).toBe('designed')
  })

  it('job.json names the scans and the order; the host order wins', async () => {
    const jobJson = new TextEncoder().encode(JSON.stringify({ contract: CONTRACT, jobId: 'from-json', order: { tooth: 3, material: 'lithium-disilicate' }, scans: { prep: 'a.stl', antagonist: 'b.stl' } }))
    const { job: j } = await jobFromBundle([{ name: 'job.json', data: jobJson.buffer }, { name: 'a.stl', data: lower }, { name: 'b.stl', data: upper }], { tooth: 19 })
    expect(j!.jobId).toBe('from-json')
    expect(j!.order.tooth).toBe(19)
    expect(j!.order.material).toBe('lithium-disilicate')
    expect(j!.scans.prep.name).toBe('a.stl')
  })

  it('asks for the tooth when nothing gives it', async () => {
    const { job: j, problems } = await jobFromBundle([{ name: 'lowerjaw.stl', data: lower }])
    expect(j).toBeNull()
    expect(problems[0]).toContain('Which tooth')
  })
})
