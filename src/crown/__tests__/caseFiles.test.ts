import { describe, expect, it } from 'vitest'
import { assignRoles, guessRole, toothFromNames } from '../caseFiles'

describe('case file roles', () => {
  it('maps upper/lower to prep/antagonist by tooth number', () => {
    expect(guessRole('Smith-upperjaw.stl', 14)).toBe('prep')
    expect(guessRole('Smith-lowerjaw.stl', 14)).toBe('antagonist')
    expect(guessRole('Smith-upperjaw.stl', 19)).toBe('antagonist')
    expect(guessRole('Smith-LowerJaw.stl', 19)).toBe('prep')
  })
  it('recognises explicit names', () => {
    expect(guessRole('19_crown_final.stl', 19)).toBe('crown')
    expect(guessRole('preparation scan.ply', null)).toBe('prep')
    expect(guessRole('Antagonist.stl', null)).toBe('antagonist')
    expect(guessRole('bite_buccal.stl', null)).toBe('bite')
    expect(guessRole('notes.txt', 19)).toBe('ignore')
  })
  it('lets case.json override guesses and reads tooth numbers from names', () => {
    const r = assignRoles(['a.stl', 'b.stl', 'crown.stl'], { toothNumber: 3, prep: 'a.stl', antagonist: 'b.stl' })
    expect(r).toEqual({ 'a.stl': 'prep', 'b.stl': 'antagonist', 'crown.stl': 'crown' })
    expect(toothFromNames(['case_30_upperjaw.stl'])).toBe(30)
    expect(toothFromNames(['tooth19.stl'])).toBe(19)
  })
})
