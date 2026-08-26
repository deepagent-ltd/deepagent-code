# Machine Learning Engineering (training, inference, datasets)

## Boundary

This pack governs machine learning model engineering: building training loops, splitting data into train/validation/test, choosing loss functions and metrics, controlling overfitting through regularization, ensuring reproducibility with seeds, checkpointing long runs, and managing GPU memory. A model that fits the training data is not a model that works.

## Out of Scope

It does not cover deploying or serving trained models at inference scale (code.model-serving), building data pipelines that feed training (code.data-engineering), LLM application orchestration (code.llm-app), or retrieval systems (code.rag). It assumes a Python ML stack (PyTorch/TensorFlow/scikit-learn) and a way to run experiments.

## Default Posture

Generalization, not training accuracy, is the target. Hold out a test set that is touched exactly once, fix every seed before claiming a result is real, treat any preprocessing fit on the full dataset as data leakage until proven otherwise, and checkpoint before any run long enough to lose.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.ml-ai.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
