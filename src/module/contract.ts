/**
 * The crown module's contract, `saycad.crown/1`: what a host (the SayCAD
 * suite, a lab system, a scanner bridge) sends, and what it gets back.
 * Every connector — in-process JS, HTTP, the embedded studio, the CLI —
 * speaks exactly these shapes, so the module can be attached anywhere
 * without the host knowing how a crown is designed.
 *
 *   host ── CrownJob ──▶ module ── CrownOutcome ──▶ host
 *   host ◀── QcDecision (from the technician, for learning) ── studio
 *
 * Plain JSON except scan/STL bytes, which travel as ArrayBuffers in-process
 * and postMessage, and as files in a zip over HTTP and on disk.
 */

import type { CriticResult } from '../crown/critics'
import type { DesignParams } from '../crown/design'
import type { ToothFrame, Vec3 } from '../crown/geom'
import type { MaterialId } from '../crown/materials'

export const CONTRACT = 'saycad.crown/1'
export const ENGINE_VERSION = '0.3.0'

export type Restoration = 'crown'
export type ToothSystem = 'universal' | 'fdi'

/** One scan, as the host has it: file bytes (STL/PLY) or an already-parsed mesh. */
export type ScanInput =
  | { name: string; data: ArrayBuffer }
  | { name: string; mesh: { positions: Float32Array; indices: Uint32Array | null } }

export interface CrownOrder {
  /** Tooth number in `system` (default Universal). */
  tooth: number
  system?: ToothSystem
  restoration?: Restoration
  material?: MaterialId
  shade?: string
  /** Host's own references, echoed back untouched. */
  caseRef?: string
  patientRef?: string
  doctor?: string
  due?: string
}

export interface CrownJob {
  contract: typeof CONTRACT
  /** Host-chosen id, echoed on the outcome. */
  jobId: string
  order: CrownOrder
  scans: {
    /** The arch with the prep. */
    prep: ScanInput
    /** The opposing arch, in occlusion. Needed for contacts and to find the prep. */
    antagonist?: ScanInput
    /** Kept for the record; not used by design yet. */
    bite?: ScanInput[]
    preop?: ScanInput
  }
  options?: {
    /** Where the prep is (world mm), when the host already knows — skips finding it. */
    tap?: Vec3
    /** A margin to design to (world mm), e.g. corrected by a technician. */
    margin?: Vec3[]
    params?: Partial<DesignParams>
    /**
     * Anatomy models (ssm JSON), keyed by tooth class ("lowerMolar") or by one
     * tooth position ("t19", Universal) — a position key wins for its tooth.
     * "donors-<class>" holds a donor set (the lab's own finished crowns, see
     * crown/donors.ts): each is tried and the least-reshaped design is kept.
     */
    anatomy?: Record<string, string>
    /** Put the insertion axis on +Z in the exported STL (CAM nesting). */
    alignInsertionToZ?: boolean
  }
}

/** Why a job stopped short of a crown, phrased for the technician. */
export interface Need {
  kind: 'tooth' | 'scan' | 'prep-location' | 'margin' | 'restoration'
  message: string
}

export type Verdict = 'ready' | 'review' | 'blocked'

export interface CrownOutcome {
  contract: typeof CONTRACT
  jobId: string
  caseRef?: string
  /** designed: a crown exists (check `verdict`); needs-input: the host must supply `needs`; failed: an error. */
  status: 'designed' | 'needs-input' | 'failed'
  needs?: Need[]
  error?: string
  /** ready: every check passes; review: warnings only; blocked: a check fails (export needs a reason). */
  verdict?: Verdict
  /** Universal number actually designed. */
  tooth?: number
  checks?: CriticResult[]
  summary?: {
    minAxialThicknessMm: number
    minOcclusalThicknessMm: number
    mesialContactMm: number | null
    distalContactMm: number | null
    occlusalMinMm: number | null
    volumeMm3: number
    marginConfidence: number
  }
  /** Intake findings about the scans (wrong jaw, units, not in the bite …). */
  intake?: string[]
  /** How the prep was located. */
  prepFoundBy?: 'host' | 'bite' | 'margin-given'
  anatomy?: string
  files?: {
    /** Binary STL, one closed solid, world coordinates unless aligned. */
    crownStl: ArrayBuffer
    crownStlName: string
    /** Everything needed to audit or reproduce the design. */
    designRecord: DesignRecord
  }
  timingsMs?: Record<string, number>
  engine: { contract: typeof CONTRACT; version: string }
}

export interface DesignRecord {
  app: 'SayCAD Crowns'
  contract: typeof CONTRACT
  engineVersion: string
  createdAt: string
  jobId: string
  caseRef?: string
  tooth: number
  material: MaterialId
  shade?: string
  scans: Array<{ name: string; role: 'prep' | 'antagonist' | 'bite' | 'preop' }>
  params: DesignParams
  margin: Vec3[]
  prepFoundBy: CrownOutcome['prepFoundBy']
  anatomy: string
  checks: CriticResult[]
  alignedToZ: boolean
  /** Tooth frame the crown was designed in (case coordinates). */
  frame?: ToothFrame
}

/** The technician's call on an outcome — sent back to the host and kept for learning. */
export interface QcDecision {
  contract: typeof CONTRACT
  jobId: string
  decision: 'approved' | 'edited' | 'rejected'
  by?: string
  at: string
  reason?: string
  /** What the technician changed before approving (for retraining). */
  edits?: { params?: Partial<DesignParams>; margin?: Vec3[] }
  /** Present when the approved crown differs from the outcome's. */
  finalCrownStl?: ArrayBuffer
}

/** Checks a job's shape before any geometry work; returns problems in plain words. */
export function validateJob(job: unknown): string[] {
  const p: string[] = []
  const j = job as Partial<CrownJob> | null
  if (!j || typeof j !== 'object') return ['The job is empty.']
  if (j.contract !== CONTRACT) p.push(`Unknown contract "${String(j.contract)}" — this module speaks ${CONTRACT}.`)
  if (!j.jobId) p.push('jobId is missing.')
  const t = j.order?.tooth
  const sys = j.order?.system ?? 'universal'
  if (typeof t !== 'number') p.push('order.tooth is missing.')
  else if (sys === 'universal' && (t < 1 || t > 32)) p.push(`Tooth ${t} is not a Universal number (1–32).`)
  else if (sys === 'fdi' && !/^[1-4][1-8]$/.test(String(t))) p.push(`Tooth ${t} is not an FDI number (11–48).`)
  if (j.order?.restoration && j.order.restoration !== 'crown') p.push(`Only anatomic crowns are designed so far, not "${j.order.restoration}".`)
  if (!j.scans?.prep) p.push('scans.prep (the arch with the prep) is missing.')
  return p
}
