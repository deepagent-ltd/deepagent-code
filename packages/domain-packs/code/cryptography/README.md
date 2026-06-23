# Applied Cryptography (Defensive Use of Primitives)

## Boundary

This pack governs the defensive, correct application of standard cryptographic primitives: authenticated encryption (AEAD), password and data hashing, key derivation (KDF), digital signatures and verification, key management and rotation, secure randomness and nonce handling, and TLS configuration. The guiding rule is to compose audited, well-named primitives correctly, never to invent algorithms.

## Out of Scope

It does not teach how to break, weaken, or attack cryptography, design novel ciphers, or bypass protections; offensive work and cryptanalysis are out of scope. It also does not cover broad application security controls (risk.security owns authz, input handling) or language plumbing (code.core). It assumes a vetted crypto library (libsodium, the platform provider, ring, Tink) is available.

## Default Posture

Never roll your own cryptography: use a vetted library's high-level interfaces and standard, named constructions. Treat keys and nonces as the hardest part of the system, default to authenticated encryption, prefer constant-time comparisons for secrets, and source all randomness from a cryptographically secure RNG. A scheme that decrypts your own test vector is not proof of security; require named constructions, current parameters, and review for anything touching secrets.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.cryptography.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
