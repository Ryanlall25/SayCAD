import { CONTRACT, type CrownJob, type CrownOutcome, type QcDecision } from './contract'

/**
 * Embedding the crown studio in a host app (the suite) with an iframe:
 *
 *   <iframe src="https://<module>/?embed=1&host=https://suite.example">
 *
 *   studio → host  { type: 'crown:ready' }                     loaded, send a job
 *   host → studio  { type: 'crown:open', job }                  scans + order (ArrayBuffers transfer)
 *   studio → host  { type: 'crown:outcome', outcome }           AI design finished (or needs input)
 *   studio → host  { type: 'crown:qc', decision, outcome? }     technician approved / edited / rejected
 *   studio → host  { type: 'crown:close' }                      user left the studio
 *
 * Every message carries `contract: 'saycad.crown/1'`. The studio only
 * accepts messages from the `host` origin given in its URL and only posts
 * to that origin.
 */

export type ToStudio = { contract: typeof CONTRACT; type: 'crown:open'; job: CrownJob }
export type FromStudio =
  | { contract: typeof CONTRACT; type: 'crown:ready' }
  | { contract: typeof CONTRACT; type: 'crown:outcome'; outcome: CrownOutcome }
  | { contract: typeof CONTRACT; type: 'crown:qc'; decision: QcDecision; outcome?: CrownOutcome }
  | { contract: typeof CONTRACT; type: 'crown:close' }

export interface EmbedHandlers {
  onReady?: () => void
  onOutcome?: (o: CrownOutcome) => void
  onQc?: (d: QcDecision, o?: CrownOutcome) => void
  onClose?: () => void
}

/** Host side: talk to a studio iframe. `studioOrigin` is where the module is served. */
export function attachCrownStudio(iframe: HTMLIFrameElement, studioOrigin: string, h: EmbedHandlers): { open: (job: CrownJob) => void; detach: () => void } {
  const onMessage = (e: MessageEvent): void => {
    if (e.origin !== studioOrigin || e.source !== iframe.contentWindow) return
    const m = e.data as FromStudio
    if (!m || m.contract !== CONTRACT) return
    if (m.type === 'crown:ready') h.onReady?.()
    else if (m.type === 'crown:outcome') h.onOutcome?.(m.outcome)
    else if (m.type === 'crown:qc') h.onQc?.(m.decision, m.outcome)
    else if (m.type === 'crown:close') h.onClose?.()
  }
  window.addEventListener('message', onMessage)
  return {
    open(job) {
      const transfer = scanBuffers(job)
      iframe.contentWindow?.postMessage({ contract: CONTRACT, type: 'crown:open', job } satisfies ToStudio, studioOrigin, transfer)
    },
    detach() {
      window.removeEventListener('message', onMessage)
    }
  }
}

/** Studio side: the host origin from `?host=`, or null when not embedded. */
export function embedHost(search: string = location.search): string | null {
  const q = new URLSearchParams(search)
  if (q.get('embed') !== '1') return null
  const h = q.get('host')
  try {
    return h ? new URL(h).origin : null
  } catch {
    return null
  }
}

/** Studio side: post to the host. */
export function toHost(host: string, m: FromStudio, transfer: Transferable[] = []): void {
  try {
    window.parent?.postMessage(m, host, transfer)
  } catch (e) {
    console.error(`saycad.crown: could not send ${m.type} to the host`, e)
  }
}

function scanBuffers(job: CrownJob): Transferable[] {
  const out: Transferable[] = []
  const add = (s?: CrownJob['scans']['prep']): void => {
    if (!s) return
    if ('data' in s) out.push(s.data)
    else {
      out.push(s.mesh.positions.buffer)
      if (s.mesh.indices) out.push(s.mesh.indices.buffer)
    }
  }
  add(job.scans.prep)
  add(job.scans.antagonist)
  job.scans.bite?.forEach(add)
  add(job.scans.preop)
  return out.filter((b, i, a) => a.indexOf(b) === i)
}
