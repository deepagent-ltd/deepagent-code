# Vector Search (embeddings, ANN, hybrid retrieval)

## Boundary

Owns turning content into vectors and retrieving by similarity: embedding choice, ANN index tuning, vector databases, hybrid lexical+vector fusion, and re-ranking. Defers prompt assembly and answer generation to code.rag.

## Out of Scope

Prompt construction and grounded generation belong to code.rag. Full-text relevance modeling beyond fusion belongs to code.search. Embedding-model training belongs to code.ml-ai.

## Default Posture

Measure retrieval with recall and precision on a labeled query set before and after every index or model change; never trade recall for latency without a recorded benchmark.

## Provenance

domain_pack:code.vector-search
