/// <reference lib="webworker" />
/**
 * The crown engine, off the UI thread. Holds the prepared case (welded scans
 * + BVHs) so scans cross the thread boundary once; every later request is a
 * tap, a margin or a params object.
 */
import { handleEngineRequest } from './engineCore'

self.onmessage = (e: MessageEvent<{ id: number; req: Parameters<typeof handleEngineRequest>[0] }>) => {
  const { id, req } = e.data
  try {
    const { result, transfer } = handleEngineRequest(req)
    ;(self as unknown as Worker).postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
