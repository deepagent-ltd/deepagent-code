# Android App Development (Jetpack Compose/Kotlin)

## Boundary

This pack governs Android application development: the Activity/Fragment lifecycle and configuration changes, Jetpack Compose's declarative UI and recomposition, ViewModel-held UI state, the Gradle build, the runtime permission model, deferred background work via WorkManager, and keeping the main (UI) thread free to avoid ANRs. The system destroys and recreates UI components freely, so state must outlive them.

## Out of Scope

It does not cover the Kotlin language itself (code.kotlin), general privacy obligations (risk.privacy), backend APIs the app calls, or Jetpack Compose for desktop. It assumes Android Studio, the SDK, and a Gradle setup already exist.

## Default Posture

State must survive configuration changes and the main thread must never block: hoist UI state into a ViewModel that outlives Activity recreation, let Compose recompose from observable state instead of mutating views, do all I/O and heavy work off the main thread to avoid ANRs, and request runtime permissions in context for only what you use.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.mobile.android.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
