import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Registry from "../../src/deepagent/domain-pack-registry"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { retrieve } from "../../src/deepagent/knowledge-retriever"
import type { ExtendedProblemProfile } from "../../src/deepagent/domain-pack-registry"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"

// docs/review_38 第0轮: lock the detector-tightening (B3) and dynamic-cap + per-pack-quota (B4)
// wins so they cannot silently regress. These mirror how profileFromInput builds the LIVE profile:
// repo_signals carries the whole task text, so detectors are exercised exactly as in production.
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

const liveProfile = (text: string): ExtendedProblemProfile => ({
  scenario_mode: "direct",
  agent_strength: "max",
  task_kind: "implement",
  code_domains: [],
  business_domains: [],
  platforms: [],
  languages: [],
  frameworks: [],
  data_classes: [],
  risk_markers: [],
  repo_signals: [text],
  round_signals: [],
  user_overrides: [],
})

const activated = (text: string): readonly string[] => {
  Registry.configureRegistry(undefined)
  const manifests = Registry.discover()
  return Registry.score(liveProfile(text), manifests)
    .filter((s) => s.score >= 0.5)
    .map((s) => s.packId)
}

describe("detector competition (docs/review_38 B3)", () => {
  test("Vue Composition API hydration does NOT activate React or frontend.performance", () => {
    const packs = activated("fix Vue Composition API ref computed template binding hydration issue")
    expect(packs).not.toContain("code.frontend.react")
    expect(packs).not.toContain("code.frontend.performance")
  })

  test("plain DB schema work does NOT activate code.mcp", () => {
    const packs = activated("review database schema constraint and add an index")
    expect(packs).not.toContain("code.mcp")
  })

  test("generic 'add a module / design the API' does NOT activate code.architecture", () => {
    const packs = activated("add a module to design the API surface")
    expect(packs).not.toContain("code.architecture")
  })

  test("project setup/bootstrap does NOT get preempted by code.query", () => {
    const packs = activated("set up the test harness and bootstrap the project")
    expect(packs).not.toContain("code.query")
  })

  test("routine dependency bump does NOT activate risk.security", () => {
    const packs = activated("bump the lodash dependency to the latest version")
    expect(packs).not.toContain("risk.security")
  })

  test("a lexer 'token' / file 'permission' mention does NOT activate risk.security", () => {
    const packs = activated("rename the token field and fix the file permission helper")
    expect(packs).not.toContain("risk.security")
  })

  test("risk.security still fires on genuine authorization-bypass tasks (no under-activation)", () => {
    const packs = activated("fix the authorization bypass and SQL injection at the trust boundary")
    expect(packs).toContain("risk.security")
  })

  test("generic database migration does NOT activate engine-specific packs (postgres/sqlite/redis)", () => {
    const packs = activated("add a database migration with a unique constraint and transaction rollback")
    expect(packs).not.toContain("code.database.postgres")
    expect(packs).not.toContain("code.database.sqlite")
    expect(packs).not.toContain("code.database.redis")
  })

  test("postgres-specific work DOES activate code.database.postgres", () => {
    const packs = activated("the EXPLAIN ANALYZE shows a slow seq scan; add a gin index in postgres")
    expect(packs).toContain("code.database.postgres")
  })

  test("generic DB migration with backfill does NOT activate code.data-engineering", () => {
    const packs = activated(
      "add database migration with unique constraint backfill transaction rollback and explain plan",
    )
    expect(packs).not.toContain("code.data-engineering")
    expect(packs).toContain("code.database")
  })

  test("genuine ETL pipeline work DOES activate code.data-engineering", () => {
    const packs = activated("build an Airflow ETL data pipeline loading into the data warehouse with Spark")
    expect(packs).toContain("code.data-engineering")
  })
})

describe("high-frequency tool-pack precision (review_4 §六)", () => {
  const fired = (text: string): readonly string[] => {
    Registry.configureRegistry(undefined)
    return Registry.score(liveProfile(text), Registry.discover())
      .filter((s) => s.score >= 0.5)
      .map((s) => s.packId)
  }
  test("'user profile form' does NOT activate code.performance (profile != profiling)", () => {
    expect(fired("add a new field to the user profile form and validate it")).not.toContain("code.performance")
  })
  test("'README setup steps' does NOT activate code.environment or platform.local-dev", () => {
    const p = fired("write a README section explaining the setup steps")
    expect(p).not.toContain("code.environment")
    expect(p).not.toContain("platform.local-dev")
  })
  test("'set the env variable' alone does NOT activate code.environment without env-task context", () => {
    // bare prose mention should not fire; a real env-doctor task should
    expect(fired("rename a function that reads the env variable")).not.toContain("code.environment")
  })
  test("genuine perf-profiling task STILL activates code.performance", () => {
    expect(fired("the profiler shows a hot path with high tail latency p99")).toContain("code.performance")
  })
  test("genuine env-bootstrap task STILL activates code.environment", () => {
    expect(fired("the dependency install fails and the runtime is missing after bootstrap the project")).toContain(
      "code.environment",
    )
  })
  test("'extract the email from the response' does NOT activate code.refactor", () => {
    expect(fired("extract the email from the response payload")).not.toContain("code.refactor")
  })
  test("'upgrade the user to premium tier' does NOT activate code.migration", () => {
    expect(fired("upgrade the user account to the premium tier")).not.toContain("code.migration")
  })
  test("genuine extract-method refactor STILL activates code.refactor", () => {
    expect(fired("extract a helper method from the payment service and rename the getUser function")).toContain(
      "code.refactor",
    )
  })
  test("genuine dependency-upgrade migration STILL activates code.migration", () => {
    expect(fired("migrate the schema and upgrade the react dependency for the breaking change")).toContain(
      "code.migration",
    )
  })
})

describe("profileFromInput domain signals (review_4 M3)", () => {
  // These tasks previously could NOT activate the pack via code_domains because profileFromInput
  // never emitted those domain tokens. They only worked if the repo_signals regex fired exactly.
  const activatedViaTaskText = (text: string): readonly string[] => {
    Registry.configureRegistry(undefined)
    const manifests = Registry.discover()
    // Simulate pure task text (no repo file context) — closest to what profileFromInput does.
    return Registry.score(liveProfile(text), manifests)
      .filter((s) => s.score >= 0.5)
      .map((s) => s.packId)
  }
  test("'deadlock in mutex lock ordering' activates code.concurrency", () => {
    expect(activatedViaTaskText("debug a deadlock in the mutex lock ordering")).toContain("code.concurrency")
  })
  test("'RTL FSM testbench in verilog' activates hardware.hdl", () => {
    expect(activatedViaTaskText("write a verilog testbench for the RTL FSM clock domain")).toContain("hardware.hdl")
  })
  test("'ETL pipeline with kafka and spark' activates code.data-engineering", () => {
    expect(activatedViaTaskText("build an ETL pipeline with kafka and spark into the warehouse")).toContain(
      "code.data-engineering",
    )
  })
  test("'reentrancy in solidity smart contract' activates code.blockchain", () => {
    expect(activatedViaTaskText("fix the reentrancy bug in the solidity smart contract evm")).toContain(
      "code.blockchain",
    )
  })
  test("'serverless lambda cold start' activates code.backend.serverless", () => {
    expect(activatedViaTaskText("reduce aws lambda cold start latency in the serverless function")).toContain(
      "code.backend.serverless",
    )
  })
  test("'machine learning training loop overfitting' activates code.ml-ai", () => {
    expect(activatedViaTaskText("fix overfitting in the pytorch training loop reduce gradient noise")).toContain(
      "code.ml-ai",
    )
  })
})

describe("batch 2/4 new packs activate (review_4 coverage)", () => {
  const fired = (text: string): readonly string[] => {
    Registry.configureRegistry(undefined)
    return Registry.score(liveProfile(text), Registry.discover())
      .filter((s) => s.score >= 0.5)
      .map((s) => s.packId)
  }
  test("FIR filter + FFT on ADC samples → hardware.signal-processing", () => {
    expect(fired("design an FIR filter and run FFT analysis on the ADC samples")).toContain(
      "hardware.signal-processing",
    )
  })
  test("I2C bus clock stretching → hardware.protocols", () => {
    expect(fired("debug I2C bus clock stretching and device address ACK")).toContain("hardware.protocols")
  })
  test("PCB trace impedance + ground plane → hardware.pcb", () => {
    expect(fired("fix PCB trace impedance and ground plane return path for EMI")).toContain("hardware.pcb")
  })
  test("XDC constraints place and route → hardware.fpga-toolflow", () => {
    expect(fired("close timing with XDC constraints after place and route in vivado")).toContain(
      "hardware.fpga-toolflow",
    )
  })
  test("clock gating + UPF power intent → hardware.power", () => {
    expect(fired("add clock gating and UPF power intent with retention registers")).toContain("hardware.power")
  })
  test("UVM constrained-random coverage → hardware.verification", () => {
    expect(fired("write a UVM testbench with constrained-random and functional coverage")).toContain(
      "hardware.verification",
    )
  })
  test("Runge-Kutta ODE solver Monte Carlo → code.simulation", () => {
    expect(fired("implement a Runge-Kutta ODE solver with Monte Carlo and numerical stability")).toContain(
      "code.simulation",
    )
  })
  test("MLflow experiment tracking model registry → code.mlops", () => {
    expect(fired("set up MLflow experiment tracking and model registry with data drift")).toContain("code.mlops")
  })
  test("LoRA int4 quantization → code.fine-tuning", () => {
    expect(fired("fine-tune with LoRA and int4 quantization using peft")).toContain("code.fine-tuning")
  })
  test("HNSW pgvector hybrid search → code.vector-search", () => {
    expect(fired("build an HNSW vector search index with pgvector and hybrid rerank")).toContain("code.vector-search")
  })
  test("Flink tumbling window watermark → code.streaming", () => {
    expect(fired("use Apache Flink stream processing with tumbling windows and watermarks")).toContain("code.streaming")
  })
  test("dbt star schema OLAP → code.analytics", () => {
    expect(fired("write a dbt model with star schema for the OLAP data warehouse")).toContain("code.analytics")
  })
  test("Airflow DAG sensor backfill → code.data-pipeline-orchestration", () => {
    expect(fired("design a workflow dag in apache airflow with a sensor task and dag scheduling")).toContain(
      "code.data-pipeline-orchestration",
    )
  })
  test("feature store train-serve skew → code.feature-engineering", () => {
    expect(fired("fix train-serve skew in the feature store with temporal leakage")).toContain(
      "code.feature-engineering",
    )
  })
})

describe("selectedRefs per-pack quota + dynamic cap (docs/review_38 B4)", () => {
  const withSeed = (fn: () => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "deepagent-quota-"))
    try {
      knowledgeSource.configure(dir)
      seedCoreKnowledge(openUserGlobalStore(dir))
      fn()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const task = (userRequest: string): TaskContext => ({
    userRequest,
    taskType: "code_modification",
    domain: "code",
    goals: [],
    successCriteria: [],
    riskBoundaries: [],
    validationCommands: [],
  })

  test("multi-domain GPU+typecheck task keeps a representative gpu ref (not starved by core/testing)", () => {
    withSeed(() => {
      const result = retrieve({
        mode: "max",
        task: task("optimize the sgemm cuda kernel for shared memory and fix the failing typecheck"),
        tools,
        round: 1,
        previousFailures: 0,
      })
      // review_4: the primary-pack guarantee is type-agnostic — gpu-kernel survives as a strategy,
      // methodology, knowledge, or skill ref. Assert across all retrieved types.
      const refs = [
        ...(result?.strategyRefs ?? []),
        ...(result?.methodologyRefs ?? []),
        ...(result?.knowledgeRefs ?? []),
        ...(result?.skillRefs ?? []),
      ]
      expect(refs.some((r) => r.includes("gpu"))).toBe(true)
    })
  })

  test("selected refs never exceed the hard ceiling of 12", () => {
    withSeed(() => {
      const result = retrieve({
        mode: "ultra",
        task: task("optimize the sgemm cuda kernel and fix typecheck and review the migration"),
        tools,
        round: 1,
        previousFailures: 0,
      })
      expect((result?.selectedRefs ?? []).length).toBeLessThanOrEqual(12)
    })
  })
})

describe("batch 1/3/5 new packs activate (review_4 coverage)", () => {
  const fired = (text: string): readonly string[] => {
    Registry.configureRegistry(undefined)
    return Registry.score(liveProfile(text), Registry.discover())
      .filter((s) => s.score >= 0.5)
      .map((s) => s.packId)
  }
  test("InnoDB gap lock binlog → code.database.mysql", () => {
    expect(fired("fix an InnoDB gap lock deadlock in the binlog replication")).toContain("code.database.mysql")
  })
  test("MongoDB aggregation $lookup sharding → code.database.mongodb", () => {
    expect(fired("design a MongoDB aggregation pipeline with $lookup and a sharding key")).toContain(
      "code.database.mongodb",
    )
  })
  test("IVFFlat pgvector recall → code.database.vector", () => {
    expect(fired("tune the IVFFlat vector index recall in pgvector")).toContain("code.database.vector")
  })
  test("Cassandra partition key tombstones → code.database.cassandra", () => {
    expect(fired("model the Cassandra partition key to avoid tombstones with quorum reads")).toContain(
      "code.database.cassandra",
    )
  })
  test("InfluxDB hypertable cardinality → code.database.timeseries", () => {
    expect(fired("fix tag cardinality explosion in the InfluxDB hypertable retention policy")).toContain(
      "code.database.timeseries",
    )
  })
  test("cache stampede stale-while-revalidate → code.caching", () => {
    expect(fired("fix the cache stampede with stale-while-revalidate and request coalescing")).toContain("code.caching")
  })
  test("git merge conflict interactive rebase → code.git-workflow", () => {
    expect(fired("resolve a git merge conflict during an interactive rebase before force push")).toContain(
      "code.git-workflow",
    )
  })
  test("CMakeLists target_link_libraries → code.build.cmake", () => {
    expect(fired("fix the CMakeLists target_link_libraries and find_package for the library")).toContain(
      "code.build.cmake",
    )
  })
  test("bazel BUILD starlark remote cache → code.build.bazel", () => {
    expect(fired("optimize the bazel BUILD file starlark rules and remote cache hits")).toContain("code.build.bazel")
  })
  test("IAM least privilege Lambda → platform.cloud.aws", () => {
    expect(fired("tighten the IAM policy least privilege for the aws Lambda and S3 bucket")).toContain(
      "platform.cloud.aws",
    )
  })
  test("Cloud Run BigQuery GCP → platform.cloud.gcp", () => {
    expect(fired("configure Cloud Run min-instances and BigQuery partitioning in GCP")).toContain("platform.cloud.gcp")
  })
  test("AKS Entra managed identity → platform.cloud.azure", () => {
    expect(fired("set up AKS with Entra ID managed identity and Bicep templates")).toContain("platform.cloud.azure")
  })
  test("helm upgrade rollback values → platform.helm", () => {
    expect(fired("debug a helm upgrade rollback with values.yaml precedence in the chart")).toContain("platform.helm")
  })
  test("Istio VirtualService mTLS → platform.service-mesh", () => {
    expect(fired("configure Istio VirtualService traffic split with mTLS and circuit breaking")).toContain(
      "platform.service-mesh",
    )
  })
  test("ansible playbook idempotent vault → platform.ansible", () => {
    expect(fired("write an idempotent ansible playbook with handlers notify and ansible vault")).toContain(
      "platform.ansible",
    )
  })
  test("PromQL recording rule SLO → platform.monitoring", () => {
    expect(fired("write a PromQL recording rule and an SLO error budget alert in alertmanager")).toContain(
      "platform.monitoring",
    )
  })
  test("CDN edge function cache-control → platform.cdn-edge", () => {
    expect(fired("set cache-control headers and a cloudflare worker edge function with origin shield")).toContain(
      "platform.cdn-edge",
    )
  })
  test("hardcoded secret rotate key → risk.secret", () => {
    expect(fired("scan for hardcoded secrets and rotate the leaked api key with gitleaks")).toContain("risk.secret")
  })
  test("tenant isolation row-level security → code.backend.multi-tenant", () => {
    expect(fired("enforce tenant isolation with row-level security and tenant-scoped queries")).toContain(
      "code.backend.multi-tenant",
    )
  })
  test("API design resource modeling versioning → code.api-design", () => {
    expect(
      fired("review the api design resource modeling and api versioning strategy with pagination design"),
    ).toContain("code.api-design")
  })
  test("tidyverse dplyr ggplot → code.r", () => {
    expect(fired("refactor the tidyverse dplyr pipeline and ggplot2 in the rstudio r script")).toContain("code.r")
  })
  test("shopping cart inventory oversell → business.ecommerce", () => {
    expect(fired("fix the shopping cart checkout flow and inventory stock reservation to avoid oversell")).toContain(
      "business.ecommerce",
    )
  })
})
