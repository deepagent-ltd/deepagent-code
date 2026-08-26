# R Language and Tidyverse

## Boundary

Governs idiomatic R: tidyverse/dplyr data pipelines, data.frame versus tibble semantics, vectorization, NA and factor handling, and reproducible package management with renv/CRAN.

## Out of Scope

Not general programming fundamentals (code.core) and not dataset validation rules themselves (code.data-quality); this pack covers how to express data work in R, not what the data must satisfy.

## Default Posture

R is vectorized and copy-on-modify by default: prefer whole-vector operations over loops, treat NA as contagious until explicitly handled, and pin dependencies so analyses reproduce.

## Provenance

domain_pack:code.r
