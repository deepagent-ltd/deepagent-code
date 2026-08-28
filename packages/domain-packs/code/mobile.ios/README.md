# iOS App Development (SwiftUI/UIKit)

## Boundary

This pack governs iOS application development: SwiftUI and UIKit view lifecycles and update models, state and data flow, ARC memory management and retain cycles, app signing and provisioning, background execution modes, App Store and privacy requirements, and keeping UI work on the main thread. The UI runs on the main thread and the system reclaims backgrounded apps aggressively.

## Out of Scope

It does not cover the Swift language itself (code.swift), general privacy-law obligations (risk.privacy), server APIs the app calls, or macOS/AppKit specifics. It assumes Xcode, a developer account, and a signing setup already exist.

## Default Posture

The main thread is sacred and state drives the UI: keep all UI updates on the main thread, let SwiftUI re-render from a single source of truth rather than mutating views imperatively, break retain cycles in closures with weak/unowned, and request only the privacy-sensitive data you actually use with a clear usage string.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.mobile.ios.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
