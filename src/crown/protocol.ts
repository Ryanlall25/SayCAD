import type { CriticResult } from './critics'
import type { DesignMeasures, DesignParams } from './design'
import type { ToothFrame, Vec3 } from './geom'
import type { MarginResult } from './margin'

/** Serializable shapes passed between the UI thread and the engine worker. */

export interface MeshData {
  positions: Float32Array
  indices: Uint32Array | null
}

export interface DesignData {
  crown: MeshData
  /** Wall thickness per crown vertex (NaN where not measured). */
  thickness: Float32Array
  nu: number
  nv: number
  frame: ToothFrame
  buccalConfidence: number
  margin: MarginResult
  results: CriticResult[]
  exportable: boolean
  summary: {
    minAxialThicknessMm: number
    minOcclusalThicknessMm: number
    mesialContactMm: number | null
    distalContactMm: number | null
    occlusalMinMm: number | null
    occlusalContactPoints: number
  }
  measures: DesignMeasures
  cuspTips: Array<{ name: string; i: number; j: number }>
  params: DesignParams
  timingsMs: Record<string, number>
  volumeMm3: number
}

export type EngineRequest =
  | { type: 'load'; toothNumber: number; prep: MeshData; antagonist: MeshData | null }
  | { type: 'setTooth'; toothNumber: number }
  | { type: 'margin'; tap: Vec3 }
  | { type: 'editMargin'; points: Vec3[]; tapped: Vec3 }
  | { type: 'design'; margin: MarginResult; params: Partial<DesignParams>; flipBuccal: boolean; quality: 'preview' | 'final'; model: string | null }
