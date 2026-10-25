import { describe, expect, it } from 'vitest'
import { dot } from '../geom'
import { autoDesign, prepareCase } from '../pipeline'
import { mirrorToUpper, syntheticMolarCase } from '../synthetic'

describe('auto design — synthetic #19', () => {
  const c = syntheticMolarCase()
  const pc = prepareCase({ toothNumber: c.toothNumber, prep: c.prep, antagonist: c.antagonist })
  const r = autoDesign(pc, { tap: c.tapPoint })

  it('builds a closed, outward-facing solid', () => {
    console.log('timings', r.timingsMs, 'measures', { ...r.outer.measures, steps: undefined })
    for (const x of r.report.results) console.log(x.verdict.padEnd(4), x.label, '|', x.measured, '|', x.required)
    expect(r.watertight.watertight).toBe(true)
    expect(r.watertight.volumeMm3).toBeGreaterThan(100)
  })

  it('reads the frame from the arch', () => {
    expect(dot(r.frame.buccal, c.buccal)).toBeGreaterThan(0.95)
    expect(dot(r.frame.mesial, c.mesial)).toBeGreaterThan(0.95)
  })

  it('meets material minimums, contacts and occlusion', () => {
    const s = r.report.summary
    expect(s.minAxialThicknessMm).toBeGreaterThanOrEqual(0.48)
    expect(s.minOcclusalThicknessMm).toBeGreaterThanOrEqual(0.68)
    expect(s.mesialContactMm).not.toBeNull()
    expect(Math.abs(s.mesialContactMm! - r.params.contactMesialMm)).toBeLessThan(0.04)
    expect(Math.abs(s.distalContactMm! - r.params.contactDistalMm)).toBeLessThan(0.04)
    expect(s.occlusalMinMm!).toBeGreaterThan(r.params.occlusalClearanceMm - 0.03)
    expect(s.occlusalContactPoints).toBeGreaterThan(0)
    expect(r.report.exportable).toBe(true)
  })
})

describe('auto design — mirrored to the upper arch', () => {
  it('produces a closed solid with outward normals (mirrored frame)', () => {
    const u = mirrorToUpper(syntheticMolarCase())
    const r = autoDesign(prepareCase({ toothNumber: u.toothNumber, prep: u.prep, antagonist: u.antagonist }), { tap: u.tapPoint })
    expect(r.watertight.watertight).toBe(true)
    expect(dot(r.frame.mesial, u.mesial)).toBeGreaterThan(0.95)
    expect(r.report.exportable).toBe(true)
  })
})

describe('every tooth class produces a closed crown', () => {
  // Same synthetic prep, read as different lower-left teeth: exercises each
  // class's template, cusp addressing and the sizing logic.
  const c = syntheticMolarCase()
  const pc0 = prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist })
  const margin = autoDesign(pc0, { tap: c.tapPoint }).margin
  for (const tooth of [18, 20, 21, 22, 23, 24]) {
    it(`#${tooth}`, () => {
      const r = autoDesign({ ...pc0, toothNumber: tooth }, { margin })
      expect(r.watertight.watertight).toBe(true)
      expect(r.watertight.volumeMm3).toBeGreaterThan(50)
      expect(r.outer.cuspTips.length).toBeGreaterThan(0)
      const thick = r.report.results.filter((x) => x.id.startsWith('thickness'))
      for (const t of thick) expect(t.verdict, `${t.label} ${t.measured}`).toBe('pass')
    })
  }
})
