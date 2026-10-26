// Runs one crown job off the main thread: bundle files + order in, outcome files out.
import { parentPort, workerData } from 'node:worker_threads'

const { designCase, jobFromBundle, outcomeFiles, outcomeJson } = await import('../dist-module/index.js')
const { files, order, jobId, anatomy, alignZ } = workerData
const { job, problems, notes } = await jobFromBundle(files, order, jobId)
if (!job) {
  parentPort.postMessage({ problems, notes })
} else {
  job.options = { ...job.options, anatomy: { ...anatomy, ...job.options?.anatomy }, alignInsertionToZ: alignZ || job.options?.alignInsertionToZ }
  const outcome = designCase(job)
  parentPort.postMessage({ notes, outcome: outcomeJson(outcome), files: outcomeFiles(outcome) })
}
