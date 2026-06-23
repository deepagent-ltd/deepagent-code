# Service Mesh

## Boundary

Covers service-mesh data and control plane: sidecar injection, traffic management (VirtualService/DestinationRule), mTLS, mesh-level retries/timeouts/circuit-breaking, canary traffic-splitting, golden-signal observability, and proxy overhead.

## Out of Scope

Base Kubernetes objects, application-level networking code, and the observability backend stack belong to platform.kubernetes, code.networking, and code.observability. Cloud load balancers and ingress controllers outside the mesh are out of scope.

## Default Posture

Inspect and render mesh config freely; shifting production traffic weights, changing mTLS mode, or altering circuit-breaker thresholds on live services is human-gated.

## Provenance

domain_pack:platform.service-mesh
