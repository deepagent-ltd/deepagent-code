# 运行真实 LLM 测试

本文面向需要在本地验证 DeepAgent Code 真实模型能力的开发者，介绍如何准备凭证、选择测试范围、启动测试，以及如何解读终端输出和 JSON 报告。

真实 LLM 测试会访问 DeepSeek 官方 API，可能产生调用费用。建议先运行 `--dry-run`，再从无 Desktop、无 EVAL 的小矩阵开始。

## 1. 前置条件

开始前请确认：

- 已安装仓库声明的 Bun 版本；
- 已执行 `bun install --frozen-lockfile`；
- 网络可以访问 `https://api.deepseek.com`；
- DeepSeek API key 有权调用配置中的模型；
- 运行 Desktop 测试时，本机具有可用的图形环境和 Desktop 构建依赖。

在仓库根目录安装依赖：

```sh
bun install --frozen-lockfile
```

## 2. 准备 API key 文件

不要把 API key 写入仓库文件、命令行参数或普通环境变量。测试使用 `DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE` 指向一个仓库外的 key 文件。

该文件只能包含一行原始 API key，不是 JSON 或 `KEY=value`。macOS 和 Linux 示例：

```sh
mkdir -p "$HOME/.config/deepagent-code"
touch "$HOME/.config/deepagent-code/live-llm-deepseek.key"
chmod 600 "$HOME/.config/deepagent-code/live-llm-deepseek.key"
${EDITOR:-vi} "$HOME/.config/deepagent-code/live-llm-deepseek.key"
```

检查文件没有多余行，并确认权限：

```sh
awk 'END { print NR }' "$HOME/.config/deepagent-code/live-llm-deepseek.key"
ls -l "$HOME/.config/deepagent-code/live-llm-deepseek.key"
```

测试不接受以下明文 key 环境变量：

- `DEEPAGENT_CODE_LIVE_LLM_API_KEY`
- `DEEPSEEK_API_KEY`

如果当前 shell 已设置它们，请先清除：

```sh
unset DEEPAGENT_CODE_LIVE_LLM_API_KEY
unset DEEPSEEK_API_KEY
```

## 3. 配置聚合测试

在仓库根目录创建本地配置：

```sh
cp script/live-llm.config.example.json script/live-llm.config.local.json
${EDITOR:-vi} script/live-llm.config.local.json
```

`script/live-llm.config.local.json` 已被 Git 忽略。配置示例：

```json
{
  "baseURL": "https://api.deepseek.com",
  "apiKeyFile": "~/.config/deepagent-code/live-llm-deepseek.key",
  "model": "deepseek-v4-flash",
  "modelRevision": "",
  "requestTimeoutMs": 180000,
  "suiteTimeoutMs": 1200000,
  "evalRuns": 5,
  "installDependencies": true
}
```

配置字段说明：

| 字段                  | 含义                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `baseURL`             | Provider endpoint。当前真实测试要求使用 `https://api.deepseek.com`。 |
| `apiKeyFile`          | key 文件路径。支持绝对路径、相对配置文件的路径和 `~/...`。           |
| `model`               | 本次测试使用的模型 ID。                                              |
| `modelRevision`       | 可选的模型修订标识；Provider 未提供明确修订时可留空。                |
| `requestTimeoutMs`    | 单次 Provider 请求超时，单位毫秒。                                   |
| `suiteTimeoutMs`      | 单个测试 suite 的总超时，单位毫秒。                                  |
| `evalRuns`            | EVAL 重复次数，范围为 1–20。次数越高，费用和耗时越高。               |
| `installDependencies` | 聚合测试是否先运行依赖安装步骤。命令行 `--skip-install` 可以覆盖它。 |

## 4. 启动聚合测试

所有聚合命令都从仓库根目录运行。

### 4.1 先检查配置和测试清单

```sh
bun run test:llm:all -- --dry-run
```

`--dry-run` 会验证配置结构和 suite 注册，并打印将要执行的命令；它不会读取 key 文件，也不会请求 Provider。

### 4.2 推荐的首次真实运行

首次运行建议跳过 Desktop、EVAL 和重复安装：

```sh
bun run test:llm:all -- --headless --skip-eval --skip-install --stop-on-failure
```

这个组合适合先确认 Provider、Core 和 CLI 的真实模型测试可以在当前机器上运行。

### 4.3 运行完整矩阵

```sh
bun run test:llm:all
```

完整矩阵包含确定性前置检查、真实模型 suites、EVAL 和 Desktop suites，耗时与 API 用量都会明显增加。

### 4.4 常用参数

| 参数                | 效果                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `--config <path>`   | 使用指定的聚合配置文件。                                           |
| `--dry-run`         | 只列出计划，不读取 key 或调用模型。                                |
| `--headless`        | 跳过所有 Desktop suites。                                          |
| `--skip-eval`       | 跳过能力评分 EVAL。                                                |
| `--skip-install`    | 跳过聚合流程中的依赖安装。                                         |
| `--stop-on-failure` | 任意 suite 失败后立即停止；否则非前置 suite 失败后会继续收集结果。 |

例如，使用另一份配置运行无 Desktop 矩阵：

```sh
bun run test:llm:all -- --config /absolute/path/live-llm.json --headless --skip-install
```

## 5. 运行单个真实模型 suite

单 suite 命令不读取聚合 JSON，需要先在当前 shell 中导出配置：

```sh
export DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE="$HOME/.config/deepagent-code/live-llm-deepseek.key"
export DEEPAGENT_CODE_LIVE_LLM_MODEL="deepseek-v4-flash"
export DEEPAGENT_CODE_LIVE_LLM_BASE_URL="https://api.deepseek.com"
export DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS="180000"
```

代表性命令：

```sh
(cd packages/llm && bun run test:llm-live:provider)
(cd packages/core && bun run test:llm-live:v2-provider-loop)
(cd packages/deepagent-code && bun run test:llm-live:cli-headless)
(cd packages/deepagent-code && bun run test:llm-ext:subagent-worktree)
(cd packages/desktop && bun run test:llm-release:ui)
```

要查看当前版本的完整 suite 清单和对应命令，运行：

```sh
bun run test:llm:all -- --dry-run
```

测试脚本必须从其所属 package 目录运行。上面的括号命令会在子 shell 中切换目录，因此可以逐条从仓库根目录复制执行。

## 6. 只运行不调用模型的前置检查

以下检查不需要 API key，也不会调用真实模型：

```sh
(cd packages/core && bun run test:llm-sandbox)
(cd packages/core && bun run test:llm-det:contracts)
(cd packages/deepagent-code && bun run test:llm-routes)
(cd packages/deepagent-code && bun run test:llm-det:contracts)
```

建议在真实模型测试前先运行这些命令。聚合 runner 也会先执行相应前置检查；如果前置检查失败，后续模型调用不会继续。

## 7. 查看测试输出和报告

### 7.1 终端输出

聚合 runner 会为每个 suite 打印类似以下内容的进度行，其中 `index` 和 `total` 会替换为实际数字：

```text
[index/total] START live:adapter-provider
[index/total] PASSED live:adapter-provider
```

最后会打印汇总和总报告路径：

```text
PASS live:adapter-provider 4.2s
REPORTED eval:autonomous 95.4s (82.50/100, 33/40 points, 3/5 full-task passes)
Report: .../packages/llm/.artifacts/live-llm/all-tests.json
```

状态含义：

| 状态                    | 含义                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `PASS` / `passed`       | suite 完成，且所有必须检查均通过。                              |
| `REPORTED` / `reported` | EVAL 正常完成并生成评分；它是测量结果，不等同于满分或能力通过。 |
| `FAIL` / `failed`       | suite 退出非零，或应生成的评分报告无效。                        |
| `timed-out`             | suite 超过 `suiteTimeoutMs`，进程被终止。                       |
| `interrupted`           | 聚合运行收到中断信号；查看 `completed` 判断已完成多少项。       |

### 7.2 报告位置

聚合报告：

```text
packages/llm/.artifacts/live-llm/all-tests.json
```

各 package 的 suite artifact 通常位于：

```text
packages/llm/.artifacts/live-llm/
packages/core/.artifacts/live-llm/
packages/deepagent-code/.artifacts/live-llm/
packages/desktop/.artifacts/live-llm/
```

Desktop suite 还可能生成 PNG 截图。相同 suite 再次运行时通常会覆盖同名 artifact；如需长期比较，请在下一次运行前复制报告。

可以用 `jq` 快速查看聚合结果：

```sh
jq '{status, fingerprint, selected, completed, completedAt}' \
  packages/llm/.artifacts/live-llm/all-tests.json

jq -r '.results[] | [.status, .id, .durationMs, .exitCode] | @tsv' \
  packages/llm/.artifacts/live-llm/all-tests.json
```

### 7.3 聚合报告字段

| 字段                   | 如何理解                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `status`               | 整个聚合运行的最终状态。所有 suite 为 `passed` 或 `reported` 时才是 `passed`。             |
| `fingerprint`          | Provider、endpoint、模型 ID 和可选模型 revision。比较两次结果前应先确认 fingerprint 一致。 |
| `selected`             | 本次计划执行的命令数。                                                                     |
| `completed`            | 实际完成并写入结果的命令数。小于 `selected` 通常表示中断或前置检查提前停止。               |
| `completedAt`          | 聚合运行写完报告的时间。                                                                   |
| `results[].id`         | suite 的稳定名称。                                                                         |
| `results[].package`    | 执行该 suite 的 workspace package。                                                        |
| `results[].realLLM`    | 是否会调用真实模型。                                                                       |
| `results[].status`     | 单个 suite 的最终状态。                                                                    |
| `results[].exitCode`   | 子进程退出码；非零通常对应失败。                                                           |
| `results[].durationMs` | suite 总耗时，包含模型响应和本地执行时间。                                                 |
| `results[].evaluation` | 仅 EVAL 项存在的聚合评分。                                                                 |
| `reportError`          | EVAL 已运行但评分报告无法读取或格式无效时的错误。                                          |

### 7.4 单 suite artifact

不同 suite 会记录与自身任务相关的额外信息，常见字段包括：

| 字段                   | 如何理解                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `suite`                | 生成该 artifact 的 suite 名称。                                                                                    |
| `mode`                 | 运行类别，例如 `live`、`ext`、`eval` 或 `release`。                                                                |
| `stack`                | 本次测试使用的产品入口。比较性能数据时应尽量保持一致。                                                             |
| `status`               | artifact 写入时的状态。`passed`/`failed` 是终态；残留的 `running` 或 `observed` 通常表示执行没有正常走到最终写入。 |
| `fingerprint`          | Provider 和模型身份。                                                                                              |
| `preflight.durationMs` | Provider 可用性检查耗时。                                                                                          |
| `usage`                | Provider 返回的 token 用量；具体结构取决于 suite 和 Provider。                                                     |
| `durationMs`           | 该 suite 或阶段的实际耗时。                                                                                        |
| `completedAt`          | artifact 完成时间。                                                                                                |

其余 `tools`、`workspace`、`evidence`、`error` 等字段用于定位具体 suite 的执行结果。判断整体是否成功时，以终端退出状态和聚合报告为准。

## 8. 理解 EVAL 指标

详细 EVAL 报告位于：

```text
packages/llm/.artifacts/live-llm/autonomous-eval.json
```

查看核心指标：

```sh
jq '.report' packages/llm/.artifacts/live-llm/autonomous-eval.json
```

| 指标                       | 如何理解                                                                   |
| -------------------------- | -------------------------------------------------------------------------- |
| `runs`                     | 实际评分运行次数。                                                         |
| `passed` / `failed`        | 完整通过或未完整通过的运行数。                                             |
| `successRate`              | `passed / runs`，范围 0–1。这是严格的完整任务成功率。                      |
| `score.earnedPoints`       | 所有运行获得的评分点数。                                                   |
| `score.possiblePoints`     | 所有运行可获得的总点数。                                                   |
| `score.normalized`         | `earnedPoints / possiblePoints`，范围 0–1。                                |
| `score.outOf100`           | `normalized` 换算成百分制，便于展示。                                      |
| `confidence95.low/high`    | 成功率的 95% Wilson 区间。样本少时区间会较宽，不应把少量运行视为稳定结论。 |
| `averages.providerTurns`   | 每次运行平均 Provider 轮数。数值升高通常意味着任务需要更多模型往返。       |
| `averages.toolCalls`       | 每次运行平均工具调用数。                                                   |
| `averages.durationMs`      | 每次运行平均耗时。                                                         |
| `averages.inputTokens`     | 每次运行平均输入 token 数。                                                |
| `averages.outputTokens`    | 每次运行平均输出 token 数。                                                |
| `averages.reasoningTokens` | Provider 报告的平均 reasoning token 数；不支持时可能为 0。                 |
| `tasks`                    | 按任务类型拆分的运行数、成功率、评分和置信区间。                           |
| `failures`                 | 按失败类别汇总的次数。                                                     |

`results` 数组保留每一次评分运行。常用字段包括任务名和 `taskSeed`、是否完整通过、该次 point score、失败类别、Provider 轮数、工具调用数、耗时与 token 用量。排查总分下降时，应先从聚合指标定位变化最大的任务，再查看对应的单次结果。

`successRate` 和 `score.outOf100` 表达不同信息：前者要求整项任务全部完成，后者允许展示部分完成度。例如某次运行没有完整通过，但完成了部分评分项，它会降低成功率，同时仍贡献部分 point score。

Token 指标用于比较用量，不是货币成本。实际费用应按 DeepSeek 账户显示的计费规则和当次请求用量计算。

常见失败类别：

| 类别                | 通常表示                                      |
| ------------------- | --------------------------------------------- |
| `preflight`         | key、endpoint 或模型可用性检查失败。          |
| `infrastructure`    | 本机环境、依赖、文件或进程启动问题。          |
| `sandbox-contract`  | 当前系统无法满足测试运行条件。                |
| `provider-contract` | Provider 请求、响应或协议层异常。             |
| `runtime-contract`  | DeepAgent Code 运行过程中出现非模型行为错误。 |
| `model-behavior`    | 模型完成了请求，但结果未满足任务评分条件。    |
| `budget`            | 超出时间、轮数或其他运行预算。                |

## 9. 结果比较建议

比较两次测试结果时，至少保持以下条件一致：

- `fingerprint.providerID`、`modelID` 和 `modelRevision`；
- `evalRuns`；
- 测试所对应的代码 commit；
- 超时配置；
- 是否使用 `--headless`、`--skip-eval` 等筛选参数。

模型输出可能存在随机性。单次 `PASS` 只能说明该次执行成功；评估稳定性时应增加 `evalRuns`，同时观察成功率、point score、置信区间、耗时和 token 用量。

## 10. 常见问题

### 提示必须设置 `DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE`

确认环境变量指向真实文件，而不是直接保存 key：

```sh
export DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE="$HOME/.config/deepagent-code/live-llm-deepseek.key"
```

### 提示 key 文件权限过宽

在 macOS 或 Linux 上执行：

```sh
chmod 600 "$DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE"
```

### 提示检测到 raw API key 环境变量

```sh
unset DEEPAGENT_CODE_LIVE_LLM_API_KEY
unset DEEPSEEK_API_KEY
```

### Provider preflight 失败

检查网络、key 权限、`baseURL` 和 `model`。模型 ID 必须出现在当前账户可用模型列表中。

### 测试超时

先定位是 Provider 请求还是整个 suite 超时，再分别调整 `requestTimeoutMs` 或 `suiteTimeoutMs`。不要用极大超时掩盖稳定复现的失败。

### Desktop 测试无法启动

先用 `--headless` 验证非 Desktop 矩阵。需要运行 Desktop 时，确认图形环境、Electron/Playwright 依赖和 Desktop build 均可用。

### 聚合报告的 `completed` 小于 `selected`

检查终端最早的失败、报告顶层 `status`，以及是否收到 SIGINT/SIGTERM。前置检查失败或用户中断都会让剩余 suite 不再执行。

## 11. 分享报告前

Artifact 会进行凭证和临时路径脱敏，但分享前仍应检查其中是否包含不应公开的 prompt、模型输出、文件内容或环境相关信息。不要分享 key 文件，也不要把本地聚合配置提交到 Git。
