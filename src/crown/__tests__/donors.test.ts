import { describe, expect, it } from 'vitest'
import { designFromDonors, parseDonorSet, type DonorSet } from '../donors'
import { autoDesign, prepareCase } from '../pipeline'
import { trainShapeModel } from '../ssm'
import { syntheticMolarCase } from '../synthetic'
import { analyseCase } from '../train'

describe('starting anatomy from the lab’s own crowns (donors)', () => {
  // Stand-in "technician crowns": the engine's own designs with varied anatomy.
  const c = syntheticMolarCase()
  const pc = prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist })
  const donors: DonorSet['donors'] = [0.8, 1.0, 1.25].map((cuspScale, k) => {
    const crown = autoDesign(pc, { tap: c.tapPoint, params: { cuspScale, occlusalContacts: false } }).crown
    const a = analyseCase({ id: `syn-${k}`, toothNumber: 19, prep: c.prep, antagonist: c.antagonist, crown })
    if (!a.ok || !a.shape) throw new Error(a.error)
    return { id: `syn-${k}`, tooth: 19, model: trainShapeModel('lowerMolar', [a.shape]) }
  })
  const set: DonorSet = { version: 1, cls: 'lowerMolar', donors }

  it('reads a donor set back and rejects anything else', () => {
    expect(parseDonorSet(JSON.stringify(set))?.donors).toHaveLength(3)
    expect(parseDonorSet('not json')).toBeNull()
    expect(parseDonorSet(JSON.stringify({ version: 2, donors: [] }))).toBeNull()
  })

  it('tries every donor on one margin and keeps the least-reshaped one that passes', () => {
    const pick = designFromDonors(pc, { tap: c.tapPoint }, set)
    expect(pick).not.toBeNull()
    expect(pick!.tried).toBe(3)
    expect(donors.map((d) => d.id)).toContain(pick!.donor)
    expect(pick!.reshapingMm).toBeGreaterThanOrEqual(0)
    expect(pick!.result.report.exportable).toBe(true)
  })

  it('leaves a donor out when asked (leave-one-out evaluation)', () => {
    const pick = designFromDonors(pc, { tap: c.tapPoint }, set, { exclude: 'syn-0' })
    expect(pick!.tried).toBe(2)
    expect(pick!.donor).not.toBe('syn-0')
  })
})
