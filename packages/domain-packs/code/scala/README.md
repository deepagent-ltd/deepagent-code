# Scala, sbt & the JVM

## Boundary

This pack governs Scala engineering: the sbt build, implicits/givens and the contextual-abstraction model, exhaustive pattern matching, effect/Future composition, the type system (variance, type classes), and the boundary to Akka/Cats-Effect libraries.

## Out of Scope

It does not cover generic JVM packaging, GC, and bytecode concerns (code.java-jvm) or language-agnostic engineering practice (code.core). It adds Scala-specific build, implicit-resolution, matching, and effect guidance and defers JVM-runtime questions to the JVM pack.

## Default Posture

Effects are described as values and composed, not run eagerly; pattern matches over sealed hierarchies are exhaustive so the compiler catches missing cases; implicits/givens are scoped and unambiguous so resolution is predictable; and the build is reproducible through pinned sbt and dependency versions.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.scala.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
