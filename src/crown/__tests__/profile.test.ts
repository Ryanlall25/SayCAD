import { describe, expect, it } from 'vitest'
import { profileCandidates } from '../margin'

// Radial profiles (r, h mm) read off lab lower-molar dies, stump top first.
const P = (s: string) => s.trim().split(/\s+/).map((x) => { const [r, h] = x.split(',').map(Number); return { r, h } })
const near = (c: Array<{ r: number; h: number }>, r: number, h: number) => c.some((x) => Math.hypot(x.r - r, x.h - h) < 0.3)

describe('reading one profile for the finish line', () => {
  // Short, tapered side: ~45° down to a ledge, then the die ditch.
  const tapered = P('0.1,2.4 0.3,2.5 0.5,2.5 0.7,2.5 1.0,2.5 1.2,2.5 1.3,2.5 1.4,2.6 1.6,2.7 1.7,2.8 1.8,2.9 1.9,3.0 2.0,3.0 2.1,2.9 2.2,2.8 2.3,2.7 2.5,2.5 2.7,2.3 2.8,2.2 2.9,2.0 3.0,1.9 3.1,1.8 3.3,1.6 3.5,1.4 3.7,1.2 3.8,1.1 3.9,1.1 4.0,1.0 4.1,0.9 4.2,0.9 4.3,0.9 4.4,0.9 4.6,0.9 4.5,0.7 4.1,-0.1 4.1,-1.0 4.4,-1.7 4.0,-4.4 3.6,-6.7 3.3,-7.9 2.9,-9.6')
  it('finds the ledge edge over a tapered wall only with the relaxed wall', () => {
    expect(near(profileCandidates(tapered, 2.4), 4.6, 0.9)).toBe(false)
    expect(near(profileCandidates(tapered, 2.4, 0.45, false, 35), 4.6, 0.9)).toBe(true)
  })

  // No die: shoulder trough, then the gum rising beside the prep.
  const gum = P('-0.2,1.3 0.3,1.2 0.6,1.2 1.0,1.2 1.4,1.3 1.8,1.4 2.2,1.5 2.4,1.5 2.6,1.5 2.8,1.4 3.0,1.3 3.2,1.1 3.4,0.8 3.6,0.4 3.7,-0.0 3.9,-0.2 3.9,-0.3 4.0,-0.4 4.2,-0.5 4.4,-0.7 4.7,-0.7 4.9,-0.7 5.1,-0.5 5.3,-0.3 5.5,-0.1 5.5,0.2 5.5,0.6 5.5,1.0 5.5,1.4 5.5,1.6 5.6,1.9 5.8,2.2 5.9,2.3 6.1,2.4 6.3,2.5 6.5,2.6 6.7,2.6 7.2,2.7 7.5,2.7 7.8,2.8 8.0,2.8')
  it('never takes the gum crest beyond a trough for the finish line', () => {
    for (const c of profileCandidates(gum, 1.3)) expect(c.h).toBeLessThan(1)
  })
})
