# Search Engineering (inverted index, ranking, Elasticsearch)

## Boundary

This pack governs full-text search engineering: building inverted indexes, designing analyzers and tokenization, mapping fields and writing query DSL in Elasticsearch/OpenSearch, tuning relevance and ranking (BM25), balancing recall against precision, and building faceting and aggregations. Search quality lives in the analyzer and the ranking, not the query string alone.

## Out of Scope

It does not cover vector/semantic retrieval for LLM context (code.rag), transactional or analytical database design (code.database), generic API design (code.backend.api), or the data pipelines that feed the index (code.data-engineering). It assumes a search cluster (Elasticsearch/OpenSearch or Lucene/Solr) and indexable documents exist.

## Default Posture

Index-time choices decide search quality more than query-time ones. The query analyzer must match the index analyzer or matches vanish silently, relevance must be measured against judged queries rather than eyeballed, and reindexing is the expected cost of any mapping or analyzer change — plan for it from the start.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.search.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
