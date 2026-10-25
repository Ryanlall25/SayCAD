import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../crown/design'
import { deleteCase, listCases, loadCase, newCaseId, saveCase, updateCase } from './caseStore'

describe('on-device case store', () => {
  it('saves, lists newest first, updates, reopens and deletes cases', async () => {
    const a = newCaseId()
    const b = newCaseId()
    const scan = { name: 'lower.stl', role: 'prep' as const, positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer, indices: null }
    await saveCase({ id: a, name: '#19 Smith', tooth: 19, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }, [scan])
    await saveCase({ id: b, name: '#3 Lee', tooth: 3, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' }, [scan])
    expect((await listCases()).map((c) => c.id)).toEqual([b, a])
    await updateCase(a, { params: { ...DEFAULT_PARAMS, cuspScale: 1.2 }, status: 'QC ✓' })
    const list = await listCases()
    expect(list[0].id).toBe(a)
    const opened = await loadCase(a)
    expect(opened!.meta.params!.cuspScale).toBe(1.2)
    expect(Array.from(new Float32Array(opened!.scans[0].positions))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    await deleteCase(b)
    expect((await listCases()).map((c) => c.id)).toEqual([a])
  })
})
