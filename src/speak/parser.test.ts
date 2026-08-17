import { describe, it, expect } from 'vitest'
import { parse, normalize } from './parser'

describe('normalize', () => {
  it('lowercases, strips punctuation, converts number words', () => {
    expect(normalize('Add Tooth Fourteen!')).toBe('add tooth 14')
    expect(normalize('rotate it thirty degrees')).toBe('rotate it 30 degrees')
    expect(normalize('twenty-nine')).toBe('29')
  })
})

describe('parse — teeth', () => {
  it('add tooth by number, with and without #', () => {
    expect(parse('add tooth 14')).toEqual({ kind: 'addTooth', tooth: 14 })
    expect(parse('crown for tooth #3')).toEqual({ kind: 'addTooth', tooth: 3 })
    expect(parse('Tooth thirty-one')).toEqual({ kind: 'addTooth', tooth: 31 })
  })
  it('rejects out-of-range tooth numbers', () => {
    expect(parse('add tooth 40').kind).toBe('unknown')
  })
  it('tooth classes', () => {
    expect(parse('add a molar')).toEqual({ kind: 'addToothType', toothType: 'molar' })
    expect(parse('place an incisor please')).toEqual({ kind: 'addToothType', toothType: 'incisor' })
  })
  it('arches', () => {
    expect(parse('build an upper arch')).toEqual({ kind: 'arch', arch: 'upper' })
    expect(parse('make the lower arch')).toEqual({ kind: 'arch', arch: 'lower' })
    expect(parse('full arch')).toEqual({ kind: 'arch', arch: 'both' })
  })
})

describe('parse — primitives', () => {
  it('box with mm dims', () => {
    expect(parse('box 20 12 6')).toEqual({ kind: 'primitive', shape: 'box', dims: [20, 12, 6] })
  })
  it('cylinder and sphere', () => {
    expect(parse('add a cylinder 5 12')).toEqual({ kind: 'primitive', shape: 'cylinder', dims: [5, 12] })
    expect(parse('sphere 8')).toEqual({ kind: 'primitive', shape: 'sphere', dims: [8] })
  })
  it('dimensionless primitives still parse (defaults applied downstream)', () => {
    expect(parse('add a cube')).toEqual({ kind: 'primitive', shape: 'box', dims: [] })
  })
})

describe('parse — manipulation', () => {
  it('directional moves with default and explicit distance', () => {
    expect(parse('move it left 5')).toEqual({ kind: 'move', axis: 'x', mm: -5 })
    expect(parse('move it up')).toEqual({ kind: 'move', axis: 'y', mm: 5 })
    expect(parse('nudge it back 2.5')).toEqual({ kind: 'move', axis: 'z', mm: -2.5 })
  })
  it('rotation with default axis and degrees', () => {
    expect(parse('rotate it 30')).toEqual({ kind: 'rotate', axis: 'y', deg: 30 })
    expect(parse('rotate it around x 90')).toEqual({ kind: 'rotate', axis: 'x', deg: 90 })
    expect(parse('turn it')).toEqual({ kind: 'rotate', axis: 'y', deg: 15 })
  })
  it('scaling by factor, percent, and words', () => {
    expect(parse('scale it 1.5')).toEqual({ kind: 'scale', factor: 1.5 })
    expect(parse('scale it 120%')).toEqual({ kind: 'scale', factor: 1.2 })
    expect(parse('bigger')).toEqual({ kind: 'scale', factor: 1.25 })
  })
  it('colors: brand aliases and css names', () => {
    expect(parse('color it gold')).toEqual({ kind: 'color', color: '#c9a24b' })
    expect(parse('paint it blue')).toEqual({ kind: 'color', color: 'blue' })
  })
  it('duplicate/delete/clear', () => {
    expect(parse('duplicate it')).toEqual({ kind: 'duplicate' })
    expect(parse('delete it')).toEqual({ kind: 'remove' })
    expect(parse('start over')).toEqual({ kind: 'clear' })
  })
})

describe('parse — session', () => {
  it('undo/redo/grid/help', () => {
    expect(parse('undo')).toEqual({ kind: 'undo' })
    expect(parse('redo')).toEqual({ kind: 'redo' })
    expect(parse('grid')).toEqual({ kind: 'grid' })
    expect(parse('help')).toEqual({ kind: 'help' })
  })
  it('export defaults to stl; ply on request', () => {
    expect(parse('export it')).toEqual({ kind: 'export', format: 'stl' })
    expect(parse('download as ply')).toEqual({ kind: 'export', format: 'ply' })
  })
  it('import', () => {
    expect(parse('import a scan')).toEqual({ kind: 'import' })
    expect(parse('load an stl')).toEqual({ kind: 'import' })
  })
  it('gibberish is unknown, never a crash', () => {
    expect(parse('purple monkey dishwasher').kind).toBe('unknown')
    expect(parse('').kind).toBe('unknown')
  })
})
