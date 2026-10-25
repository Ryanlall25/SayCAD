import type { DesignParams } from '../crown/design'
import type { FileRole } from '../crown/caseFiles'
import type { MarginResult } from '../crown/margin'
import type { CaseOrder } from '../crown/order'

/**
 * On-device case storage (IndexedDB): the scans as loaded plus the design
 * state (margin, parameters, orientation), so a case survives closing the
 * app and can be reopened and re-exported later. Nothing leaves the device.
 *
 * Two stores keep the recent-cases list cheap: `meta` (small records) and
 * `scans` (the large mesh buffers, read only when a case is opened). Every
 * call degrades to a no-op/empty result where storage is unavailable
 * (private browsing, blocked site data).
 */

export interface StoredScan {
  name: string
  role: FileRole
  positions: ArrayBuffer
  indices: ArrayBuffer | null
}

export interface CaseMeta {
  id: string
  name: string
  tooth: number
  createdAt: string
  updatedAt: string
  params?: DesignParams
  flip?: boolean
  margin?: MarginResult | null
  /** Short QC summary, e.g. "QC ✓" or "2 fail". */
  status?: string
  /** The order from the New Case flow (patient, doctor, shade, …). */
  order?: CaseOrder
}

const DB_NAME = 'saycad-crowns'
const VERSION = 2

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans')
        if (!db.objectStoreNames.contains('models')) db.createObjectStore('models')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(stores, mode)
          const req = run(t)
          t.oncomplete = () => {
            db.close()
            resolve(req ? (req.result as T) : (true as unknown as T))
          }
          t.onerror = () => {
            db.close()
            resolve(null)
          }
          t.onabort = () => {
            db.close()
            resolve(null)
          }
        } catch {
          db.close()
          resolve(null)
        }
      })
  )
}

export function newCaseId(): string {
  return `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export async function saveCase(meta: CaseMeta, scans: StoredScan[]): Promise<boolean> {
  const ok = await tx(['meta', 'scans'], 'readwrite', (t) => {
    t.objectStore('meta').put(meta)
    t.objectStore('scans').put(scans, meta.id)
  })
  return ok !== null
}

export async function updateCase(id: string, patch: Partial<CaseMeta>): Promise<void> {
  const meta = await tx<CaseMeta>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id))
  if (!meta) return
  await tx(['meta'], 'readwrite', (t) => {
    t.objectStore('meta').put({ ...meta, ...patch, id, updatedAt: new Date().toISOString() })
  })
}

export async function listCases(): Promise<CaseMeta[]> {
  const all = (await tx<CaseMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) ?? []
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadCase(id: string): Promise<{ meta: CaseMeta; scans: StoredScan[] } | null> {
  const meta = await tx<CaseMeta>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id))
  const scans = await tx<StoredScan[]>(['scans'], 'readonly', (t) => t.objectStore('scans').get(id))
  return meta && scans ? { meta, scans } : null
}

export async function deleteCase(id: string): Promise<void> {
  await tx(['meta', 'scans'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id)
    t.objectStore('scans').delete(id)
  })
}

/** Anatomy models imported on this device (e.g. from a tooth library), by tooth class. */
export async function saveModel(cls: string, json: string): Promise<boolean> {
  return (await tx(['models'], 'readwrite', (t) => {
    t.objectStore('models').put(json, cls)
  })) !== null
}

export async function loadModel(cls: string): Promise<string | null> {
  return (await tx<string>(['models'], 'readonly', (t) => t.objectStore('models').get(cls))) ?? null
}

export async function clearModels(): Promise<void> {
  await tx(['models'], 'readwrite', (t) => {
    t.objectStore('models').clear()
  })
}
