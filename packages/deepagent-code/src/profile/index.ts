/**
 * P1A (S1-v3.5): PAP — the Profile Adapter Protocol module barrel.
 *
 * - `PAP`        — three-stage `ProfileAdapter` contract + `NormalizedProfile`/`RawProfile`/
 *                  `ProfileTarget`/`NativeReportRef`/`Hotspot`/`MetricValue` types + profile
 *                  structural validation.
 * - `Vocabulary` — the vendor-neutral metric vocabulary (tables 1/2/3) + `validateMapping`
 *                  (registration-time completeness/honesty check) + `validateProfile`
 *                  (vocabulary conformance).
 */
export * from "./pap"
export * from "./vocabulary"
export * from "./service"
