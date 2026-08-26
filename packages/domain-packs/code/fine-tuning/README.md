# Fine-Tuning (LoRA, quantization, distillation, adapters)

## Boundary

Owns adapting a pretrained model to a task: PEFT methods, quantization, distillation, adapter merge strategies, and evaluating the adapted model against its base. Defers prompt-level work and serving plumbing.

## Out of Scope

Prompt design and orchestration belong to code.llm-app. Serving infrastructure and autoscaling belong to code.model-serving. From-scratch architecture work belongs to code.ml-ai.

## Default Posture

Prefer the smallest intervention that meets the target: try parameter-efficient adapters and prompting before full fine-tuning, and always evaluate the adapted model against the base on held-out task and capability sets.

## Provenance

domain_pack:code.fine-tuning
