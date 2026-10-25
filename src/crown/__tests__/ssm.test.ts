import { describe, expect, it } from 'vitest'
import { autoDesign, prepareCase } from '../pipeline'
import { syntheticMolarCase } from '../synthetic'
import { project, synthesise, templateFromModel } from '../ssm'
import { analyseCase, evaluate, trainModels, trainingReport, type TrainingCase } from '../train'

describe('learning anatomy from finished cases (synthetic stand-ins)', () => {
  // Stand-in "technician crowns": the engine's own designs with varied anatomy.
  const c = syntheticMolarCase()
  const pc = prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist })
  const variants = [
    { cuspScale: 0.8, buccalBulgeMm: 0 },
    { cuspScale: 1.0, buccalBulgeMm: 0.2 },
    { cuspScale: 1.2, buccalBulgeMm: 0.1 },
    { cuspScale: 0.9, lingualBulgeMm: 0.2 }
  ]
  const cases: TrainingCase[] = variants.map((p, k) => ({
    id: `syn-${k}`,
    toothNumber: 19,
    prep: c.prep,
    antagonist: c.antagonist,
    crown: autoDesign(pc, { tap: c.tapPoint, params: { ...p, occlusalContacts: false } }).crown
  }))
  const analyses = cases.map(analyseCase)

  it('traces every crown and scores the margin finder against the crown margin', () => {
    for (const a of analyses) {
      expect(a.ok, a.error).toBe(true)
      expect(a.marginError!.mean).toBeLessThan(0.1)
    }
  })

  it('learns a model whose modes reconstruct the training crowns', () => {
    const models = trainModels(analyses)
    const m = models.lowerMolar!
    expect(m.count).toBe(4)
    expect(m.modes.length).toBeGreaterThan(0)
    for (const a of analyses) expect(project(m, a.shape!).residualRms).toBeLessThan(0.05)
    const g = synthesise(m, [1])
    expect(g.pts.length).toBe(m.nu * m.nv * 3)
    const t = templateFromModel(m)
    expect(t.cuspTips.length).toBeGreaterThan(3)
  })

  it('evaluates leave-one-out and writes a report', () => {
    const rows = evaluate(cases, analyses)
    expect(rows.length).toBe(4)
    for (const r of rows) {
      expect(r.learned).toBeDefined()
      expect(r.learned!.mean).toBeLessThan(0.35)
    }
    const md = trainingReport(analyses, trainModels(analyses), rows)
    expect(md).toContain('leave-one-out')
  }, 180000)
})
