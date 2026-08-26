# Feature Engineering (stores, drift, leakage, encoding)

## Boundary

Owns how raw signals become model features: encoding, selection, normalization contracts, leakage prevention, and online/offline consistency through a feature store. Defers model training and serving infrastructure elsewhere.

## Out of Scope

Model architecture and training loops belong to code.ml-ai. Raw ingestion and warehouse modeling belong to code.data-engineering. Generic schema validation belongs to code.data-quality.

## Default Posture

Treat the offline and online feature definitions as one contract: any transform that exists at training time must exist identically at serving time, computed from point-in-time-correct data.

## Provenance

domain_pack:code.feature-engineering
