import type { DesignParams } from './design'
import type { Vec3 } from './geom'
import type { MarginResult } from './margin'
import type { DesignData, EngineRequest, MeshData } from './protocol'

/**
 * Promise API over the engine worker. Falls back to running the engine on
 * the UI thread where module workers are unavailable.
 */
export class CrownEngine {
  private worker: Worker | null = null
  private workerFailed = false
  /** Last scans sent, so an in-thread fallback can be re-primed. */
  private lastLoad: EngineRequest | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      // A worker that can't load (blocked by a host's CSP, old browser) fails
      // asynchronously: drop it and run the engine on this thread instead.
      this.worker.onerror = (ev) => {
        ev.preventDefault?.()
        this.worker?.terminate()
        this.worker = null
        this.workerFailed = true
        const stranded = [...this.pending.values()]
        this.pending.clear()
        for (const p of stranded) p.reject(new Error('engine restarted — please repeat that step'))
      }
      this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
        const p = this.pending.get(e.data.id)
        if (!p) return
        this.pending.delete(e.data.id)
        if (e.data.ok) p.resolve(e.data.result)
        else p.reject(new Error(e.data.error))
      }
    } catch {
      this.worker = null
    }
  }

  private async call<T>(req: EngineRequest, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) {
      const { handleEngineRequest } = await import('./engineCore')
      if (this.workerFailed && this.lastLoad && req.type !== 'load') {
        handleEngineRequest(this.lastLoad)
        this.workerFailed = false
      }
      return handleEngineRequest(req).result as T
    }
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker!.postMessage({ id, req }, transfer)
    })
  }

  load(toothNumber: number, prep: MeshData, antagonist: MeshData | null): Promise<{ triangles: number }> {
    // Copies go to the worker; the UI keeps its own geometry for display.
    const cp = (m: MeshData): MeshData => ({ positions: m.positions.slice(), indices: m.indices ? m.indices.slice() : null })
    const p = cp(prep)
    const a = antagonist ? cp(antagonist) : null
    const transfer: Transferable[] = [p.positions.buffer]
    if (p.indices) transfer.push(p.indices.buffer)
    if (a) {
      transfer.push(a.positions.buffer)
      if (a.indices) transfer.push(a.indices.buffer)
    }
    // Keep untransferred copies for a possible in-thread fallback.
    this.lastLoad = { type: 'load', toothNumber, prep: cp(prep), antagonist: antagonist ? cp(antagonist) : null }
    return this.call({ type: 'load', toothNumber, prep: p, antagonist: a }, transfer)
  }

  setTooth(toothNumber: number): Promise<boolean> {
    return this.call({ type: 'setTooth', toothNumber })
  }

  margin(tap: Vec3): Promise<MarginResult> {
    return this.call({ type: 'margin', tap })
  }

  editMargin(points: Vec3[], tapped: Vec3): Promise<Vec3[]> {
    return this.call({ type: 'editMargin', points, tapped })
  }

  design(margin: MarginResult, params: Partial<DesignParams>, flipBuccal: boolean, quality: 'preview' | 'final', model: string | null): Promise<DesignData> {
    return this.call({ type: 'design', margin, params, flipBuccal, quality, model })
  }

  importLibrary(files: Array<{ name: string; mesh: MeshData }>, numbering: 'auto' | 'universal' | 'fdi', source: string, jaw?: 'upper' | 'lower'): Promise<{
    teeth: Array<{ name: string; tooth: number; cls: string; ok: boolean; error?: string }>
    skipped: string[]
    models: Record<string, string>
  }> {
    return this.call({ type: 'importLibrary', files, numbering, source, jaw })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
