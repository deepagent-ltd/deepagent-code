# Prometheus and Grafana Monitoring

## Boundary

Governs the Prometheus/Grafana monitoring stack: PromQL query authoring, recording and alerting rules, Alertmanager routing, SLI/SLO and error-budget design, dashboards, and scrape/label-cardinality control.

## Out of Scope

Not application instrumentation or trace/span design (code.observability) and not cluster scheduling (platform.kubernetes); this pack covers the Prometheus and Grafana stack specifics, not how code emits signals.

## Default Posture

Alert actionability and label cardinality are the dominant axes: every alert must map to a human action, and unbounded label values are a capacity risk that degrades the whole TSDB.

## Provenance

domain_pack:platform.monitoring
