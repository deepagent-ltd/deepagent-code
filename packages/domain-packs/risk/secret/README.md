# Secret Handling and Detection

## Boundary

Covers detecting secrets in code and history, scanning before commit, rotating leaked or aging credentials, and using a vault or secret manager so secrets never live in source.

## Out of Scope

It does not cover general authentication or authorization logic, which belongs to risk.security and the backend.auth pack; this pack is about the lifecycle and containment of secret material itself.

## Default Posture

Treat any secret in source or history as a leak requiring rotation; never advise relaxing scanning, committing secrets, or weakening rotation, and escalate exposure to a human.

## Provenance

domain_pack:risk.secret
