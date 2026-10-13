# Dart & Flutter

## Boundary

This pack governs Dart and Flutter engineering: pub/pubspec dependency management, the widget tree and state lifecycle, Dart async (Future/Stream/isolates), the Flutter build pipeline, platform channels to native code, and the hot-reload development model.

## Out of Scope

It does not cover language-agnostic engineering practice (code.core) or generic mobile platform concerns like store submission and OS permissions (code.mobile). It adds Dart/Flutter-specific build, widget, and async guidance and defers cross-platform mobile policy to the mobile pack.

## Default Posture

The UI is a function of immutable state rebuilt by the framework, so state changes flow through the chosen state-management mechanism rather than mutation. The build method stays pure and cheap, expensive and blocking work moves off the UI isolate, and resources tied to widgets are disposed.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.dart-flutter.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
