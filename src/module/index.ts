/**
 * SayCAD crown module — public API (`saycad.crown/1`).
 *
 *   designCase(job)            headless, fully automated design → outcome
 *   jobFromBundle(files, …)    files / a scanner zip → job
 *   outcomeFiles / outcomeZip  outcome → crown STL + outcome.json + design record
 *   attachCrownStudio(…)       host side of the embedded studio (iframe)
 *
 * Everything else under src/ is internal and may change between versions;
 * hosts depend only on what this file exports.
 */
export * from './contract'
export { designCase, binaryStl } from './designCase'
export { jobFromBundle, expandBundle, outcomeFiles, outcomeJson, outcomeZip, type BundleFile, type BundleJob } from './bundle'
export { attachCrownStudio, type EmbedHandlers, type FromStudio, type ToStudio } from './embed'
