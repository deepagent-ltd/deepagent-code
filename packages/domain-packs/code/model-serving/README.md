# Model Serving (inference serving, batching, latency)

## Boundary

This pack governs serving trained models in production: standing up inference servers, dynamic/continuous batching, trading latency against throughput, keeping GPUs utilized, versioning models for safe rollout, autoscaling under bursty load, mitigating cold starts, and quantizing for serving. The bottleneck is rarely the model's math; it is batching, memory, and queueing.

## Out of Scope

It does not cover training or evaluating the model (code.ml-ai), building data pipelines (code.data-engineering), generic web API design (code.backend.api), or LLM application logic and prompts (code.llm-app). It assumes a trained model artifact, a GPU/accelerator runtime, and a serving framework are available.

## Default Posture

Optimize tail latency and GPU utilization together, never throughput in isolation. Batch dynamically with a bounded queue and timeout, gate every model version behind a health check and a rollback, size memory for the worst concurrent batch, and measure p99 under realistic load before claiming a serving system is fast.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.model-serving.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
