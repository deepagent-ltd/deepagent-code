# Release Evidence — V4.1 发布证据归档

本目录存放 V4.1 发布门禁（BUG-407-005）的可追溯证据。每个 gate 产出一份**不可变**的
`manifest.json`，记录 gate 结论、证据条目（类型/文件/SHA-256/结论）与签字占位。

规格来源：[`docs/bug-407-005.md`](../docs/bug-407-005.md) §1 Evidence Manifest 与 §7 Gate State Rules。

## 目录结构

```text
release-evidence/
├── README.md                  # 本文件：结构与不可变语义说明
├── manifest.schema.json       # manifest JSON Schema（draft-07）
└── v4.1/
    └── <commit-sha>/          # 证据绑定的完整 git commit SHA
        └── <gate-id>/
            ├── manifest.json  # 不可变 gate manifest（由 script/release-evidence.ts 生成）
            ├── logs/          # 可选：原始测试/命令日志
            ├── db/            # 可选：数据库快照、migration ledger
            ├── requests/      # 可选：provider request 哈希与脱敏 payload
            └── ui/            # 可选：UI capture
```

- `<commit-sha>`：完整 40 位 git SHA。证据必须绑定到产出它的那个 commit；
  source/bundle/migration/flags/provider 任一变化都会使相关证据失效（见 §7），
  新 commit 必须重新跑 gate，不得引用旧 artifact 充数。
- `<gate-id>`：gate 标识，如 `release-gate-20260819`、`R1-C`、`R2-S3`、`R3-EVT-1000`。
- 原始日志/产物不在仓库时，manifest 的 evidence 条目可以只有文本结论
  （`path: null`、`sha256: null`），但结论必须写明事实与来源。

## Manifest 字段（详见 manifest.schema.json）

| 字段 | 说明 |
|---|---|
| `schema_version` | 固定 `deepagent.release_evidence.v1` |
| `version` | 发布线，如 `v4.1` |
| `gate_id` | gate 名 |
| `commit` | 证据绑定的完整 commit SHA |
| `date` | gate 执行日期（YYYY-MM-DD） |
| `generated_at` | manifest 生成时间（ISO-8601 UTC） |
| `status` | `passed` / `failed` / `blocked` / `not_run` |
| `summary` | gate 总体结论 |
| `evidence[]` | 证据条目：`kind`（类型）、`label`、`path`（文件，可空）、`sha256`（可空）、`conclusion`（结论） |
| `signatures[]` | 签字占位：`role` / `actor` / `at`；签字链要求 domain owner 与 release owner 各自签字 |

证据条目 `kind` 分类对应 BUG-407-005 的证据层级：
`test-summary`（R1 确定性测试）、`migration`（M1-M4）、`smoke` / `live`（R2 live）、
`capacity`（R3 容量）、`log` / `db` / `request` / `ui` / `receipt` / `metric`（原始 artifact）。

## 不可变语义

1. **manifest 一旦生成不得修改**。`script/release-evidence.ts` 不提供覆盖写：
   目标 `manifest.json` 已存在时重复生成直接报错退出。
2. 修订、重试或结论变化 → 使用新的 gate attempt（新的 `<gate-id>`，
   如 `release-gate-20260819-attempt2`）生成新 manifest，不覆盖旧证据。
3. `--check` 校验 manifest 中记录的文件 SHA-256 未被篡改；任何哈希不一致即为篡改，判为失败。
4. secret、完整敏感 prompt 与 provider credential 不进入 manifest；
   request artifact 使用 canonical hash + 脱敏结构化 payload。

## 工具用法

```bash
# 生成 gate manifest（重复生成会报错，不覆盖）
bun script/release-evidence.ts archive \
  --gate release-gate-20260819 \
  --date 2026-08-19 \
  --status passed \
  --summary "总体结论" \
  --evidence "test-summary:full-suite" \
  --conclusion "full-suite=4967 pass / 0 fail" \
  --evidence "log:run-log:packages/core/run.log" \
  --sign "domain-owner=<name>" --sign "release-owner=<name>"

# 校验已有 manifest 的文件哈希未被篡改
bun script/release-evidence.ts check --gate release-gate-20260819
bun script/release-evidence.ts check release-evidence/v4.1/<commit>/<gate>/manifest.json
```
