# Vector Database Engine

## Boundary

Covers the vector database engine layer: ANN index types and their build/query parameters, distance metrics, dimensionality, hybrid filter-plus-vector queries, quantization, and capacity planning across pgvector, Milvus, Qdrant, and similar. The retrieval and ranking algorithm layer lives in code.vector-search.

## Out of Scope

Embedding model selection, chunking strategy, RAG prompt assembly, and re-ranking algorithms are out of scope and belong to code.vector-search and code.ml-ai; this pack is about the index and storage engine.

## Default Posture

Default to a metric matching the embedding model's training objective, an ANN index sized to the dataset, and a measured recall target; treat unbounded exact search over millions of vectors as a defect.

## Provenance

domain_pack:code.database.vector
