# DeepAgent Code 真实 LLM 测试标准与运行指南

本文是仓库中真实 LLM 测试设计、覆盖、运行、资格认证和审阅标准的唯一权威文件。历史 `docs/llmrealtest*.md`、LLM 测试审阅记录和覆盖矩阵只保留迁移指针，不再定义合同；任何冲突以本文和当前源码注册表为准。

本文面向需要设计、审阅或运行 DeepAgent Code 真实模型测试的开发者，说明凭证、安全边界、Oracle、路由、资格和结果解释。真实 LLM 测试会访问 DeepSeek 官方 API，可能产生调用费用；先运行 `--dry-run`，再从无 Desktop、无 EVAL 的小矩阵开始。

## 0. 权威状态与硬合同

截至 2026-07-31，聚合 runner 注册 55 条命令，其中 48 条调用真实模型；headless 矩阵为 48 条命令、43 条真实模型 suite，进一步跳过 EVAL 和安装后为 46 条命令、42 条真实模型 suite。数字由 `script/run-live-llm-all.ts` 动态注册表决定，文档数字发生漂移时以注册表和 `validateSuiteManifest()` 为准。

`qualifiedLiveRuns` 当前为空。注册、单次通过和 EXT 可达都不代表 pre-push 资格；LIVE suite 只有完成本节资格合同后才能进入该集合。

| 模式    | 用途                                   | 真实模型 | 普通 pre-push    |
| ------- | -------------------------------------- | -------- | ---------------- |
| DET     | 状态机、路由、安全和 Oracle 自检       | 否       | 是               |
| LIVE    | 小型、稳定、低成本生产合同             | 是       | 资格通过后可进入 |
| EXT     | 多 Agent、故障恢复、长会话和高成本编排 | 是       | 否               |
| EVAL    | 多 seed 能力评分                       | 是       | 否，只报告       |
| RELEASE | Desktop、GUI 和 packaged sidecar       | 是       | 否               |

所有真实 suite 必须满足以下不变量：

1. 只允许 `https://api.deepseek.com`，并记录 provider、模型、revision 和 generation fingerprint。
2. API key 只从 `DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE` 指向的仓库外 `0600` 单行文件读取；raw key 环境变量一律拒绝。
3. HOME、应用数据、数据库、workspace 和临时目录全部隔离；子进程只继承显式环境 allowlist。
4. 工具权限默认 deny；Bash suite 在请求 provider 前完成 sandbox conformance，并拒绝宿主文件、symlink escape 和网络。
   Python hidden verifier 必须通过 sandbox 选择的原生 Python 运行时执行；运行时不可用或不能产生结构化 verifier marker 时，结果归类为 `sandbox-contract`，不得归因于模型。
5. 通过条件优先使用 fresh-copy verifier、精确磁盘状态、durable Session/tool/PR 状态和 typed terminal reason；模型自述不能单独判定通过。
6. suite 必须有 provider turn、工具调用、输出、磁盘、并发和 wall-time 上限，结束时不得残留进程、权限请求或问题请求。
7. 失败必须归类为 `preflight`、`sandbox-contract`、`provider-contract`、`runtime-contract`、`model-behavior`、`budget` 或 `harness-bug`，并报告最早失效层。

LIVE 资格要求 committed harness、固定 fingerprint、至少三个独立进程连续 30/30、mutation/self-test、14 天滚动稳定性、artifact 脱敏审阅和负责人批准。复杂多 Agent、长会话、Desktop 与 EVAL 原则上保持 EXT/RELEASE；没有上述证据不得加入 `qualifiedLiveRuns`。

Provider prompt cache 的归因也必须 fail closed：同一 Session 的 system prefix 和工具 schema/order 若由 DeepAgent Code 改变，先判 `runtime-contract`；只有 assembled prefix identity、历史和参数稳定而 provider cache read 仍崩溃时，才允许判 `provider-contract`。round、plan、World State、schema 和 finalizer 等逐轮信息只能进入 ephemeral runtime tail，不能污染稳定 system prefix。

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
mkdir -p "$HOME/.deepagent/code"
touch "$HOME/.deepagent/code/live-llm-deepseek.key"
chmod 600 "$HOME/.deepagent/code/live-llm-deepseek.key"
${EDITOR:-vi} "$HOME/.deepagent/code/live-llm-deepseek.key"
```

检查文件没有多余行，并确认权限：

```sh
awk 'END { print NR }' "$HOME/.deepagent/code/live-llm-deepseek.key"
ls -l "$HOME/.deepagent/code/live-llm-deepseek.key"
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
  "apiKeyFile": "~/.deepagent/code/live-llm-deepseek.key",
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
export DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE="$HOME/.deepagent/code/live-llm-deepseek.key"
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
(cd packages/deepagent-code && bun run test:llm-ext:multi-agent-parallel-worktrees)
(cd packages/deepagent-code && bun run test:llm-ext:multi-agent-pr-collaboration)
(cd packages/deepagent-code && bun run test:llm-ext:v4-multi-agent-runtime)
(cd packages/deepagent-code && bun run test:llm-ext:subagent-intensity)
(cd packages/deepagent-code && bun run test:llm-ext:subagent-resume)
(cd packages/deepagent-code && bun run test:llm-ext:subagent-takeover)
(cd packages/desktop && bun run test:llm-release:ui)
```

要查看当前版本的完整 suite 清单和对应命令，运行：

```sh
bun run test:llm:all -- --dry-run
```

测试脚本必须从其所属 package 目录运行。上面的括号命令会在子 shell 中切换目录，因此可以逐条从仓库根目录复制执行。

### 5.1 并行多 Agent 回归

`multi-agent-dag` 验证 researcher、worker PR 合并、结果 reviewer 的串行交接；worker 与结果 reviewer 之间必须真实经过 `pr_finalize` 的普通 Reviewer 和 Senior Reviewer。`expert-panel` 验证 panel 专用路径的并发。通用 `task` 协作链路的权威并行回归是 `multi-agent-parallel-worktrees`：父 Agent 必须在同一次模型响应中启动两个前台 worker，每个 worker 使用独立 Git worktree 完成一项文件修改。

测试在两个 worker 的 `Permission.ask` 之间设置屏障。在两个请求都进入 pending 之前不会批准任何一个，因此通过不依赖耗时阈值的方式证明真实重叠。Oracle 同时要求父会话能够列举并回复两个子会话权限、事件路由回到父目录、两个 worktree 各自保留唯一且通过隐藏 verifier 的产物、父工作区零泄漏、父 Agent 汇总两个结果，且结束后没有残留 pending permission。显式 `isolation: "worktree"` 的契约是保留改动等待后续显式合并，并不自动 merge-back。任何 worker 未启动、串行启动、事件丢失、权限不可见、worktree 冲突或子 Agent 卡住都会使 suite 非零退出。

### 5.2 Git/PR 多 Agent 闭环

`multi-agent-pr-collaboration` 是自动写协作的权威生产入口回归。父 Agent 必须在同一模型响应中并行启动两个未显式指定 `isolation` 的前台 worker；生产 `task` 工具为它们创建独立 worktree，提交各自受作用域约束的 commit，并将两条 PR 持久化到同一批次。父 Agent 随后单独调用一次 `pr_finalize`，由同一个普通 Reviewer Session 逐 PR 审查精确 worker SHA、协调器在 Session 分支串行执行两次 `--no-ff` merge，最后由同一个 Senior Reviewer Session 完成批次级复审。

Oracle 不依赖父模型的成功文本。它直接核验 queue.json 中两条 PR 均为 `merged`、parent/worker/reviewer/batch 身份一致、verdict 绑定精确 SHA；Git 一方必须位于 `deepagent-code/session-*` 分支，first-parent 历史恰有两个双亲 merge commit，父工作区干净且两个隐藏 marker 均存在；会话一方必须恰有两个 worker、一个 Reviewer、一个 Senior Reviewer，所有子会话持久化终态，worker worktree 全部删除，权限屏障证明两个 worker 真正重叠，且没有残留权限请求。默认分支（包括仓库解析出的自定义默认分支以及 `main`、`master`、`dev`）不得成为 PR merge 目标。

### 5.3 子 Agent 强度继承与降级

`subagent-intensity` 使用真实 `task` 生产入口分别验证两种配置。父 Agent 固定为 `max`：`inherit` 必须不注入 `agent_mode_override`，且子请求组装后的最终强度仍为 `max`；`downgrade` 必须在子 prompt 元数据中注入 `xhigh`，且请求组装后的最终强度确实为 `xhigh`。Oracle 同时核验唯一子 Session 的 parent lineage、真实 Provider/模型身份、持久化终态和无工具纯文本结果，防止只测试配置解析而没有覆盖真实模型请求。

### 5.4 子 Agent 恢复、监督和失败边界

`subagent-resume` 必须通过两次真实前台 `task` 调用复用同一个 child Session。第二次调用的 `task_id` 必须等于持久化 child ID；child generation 必须从 1 推进到 2；两代必须分别完成目标文件的真实 `read`，并各完成一次 `StructuredOutput`；最终 durable metadata 为 `completed/structured_output_valid`，且第二代结果保留第一代证据并加入新证据。Oracle 同时拒绝 provider error、错误 lineage、错误模型身份、新建第二 child、非 read/finalizer 工具或目标 read 没有返回隐藏证据；权限范围内的额外只读探查不属于产品故障。

监督合同由确定性测试承担：前台 task 默认有有限 wall time；超时或崩溃后旧 generation 必须被取消并失去写终态资格，接管 generation 只能有一个 owner；父 Agent 收到有界输出而不是无限子 transcript；取消、作用域释放和 cleanup 必须中断仍存活的 fiber。增加退出条件但仍让旧执行继续写状态不算修复。

`subagent-takeover` 使用真实 DeepSeek child 的 `question` 工具制造可观测挂起点，harness 不回复问题。生产 timeout 必须取消原 child，再启动恰好一个 takeover child；达到配置上限后 task 以 typed timeout 和 `task_read` 恢复指针返回，两个 child 分别持久化 `cancelled/takeover` 与 `error/timeout`，所有 Question pending entry 必须清零。suite 不允许用测试总超时杀进程来冒充产品收敛。

Git 合同分入口定义：交互式写型 `task` 使用独立 worktree，并在自动协作模式提交 PR；`pr_finalize` 绑定精确 worker SHA，由同一个普通 Reviewer Session 逐项审查、串行 `--no-ff` merge，再由一个 Senior Reviewer Session 做批次复审。Senior review 在 merge 后崩溃时，queue 必须持久化 `stageReview: pending` 和 reviewer Session ID，重试复用同一 Session，不能把已 merge 批次误报为“无待办”。父 checkout 有未提交改动时必须在启动 worker/model 前失败；不得自动提交、覆盖或清理用户改动。

事件驱动 V4 DAG 是独立生产入口：独立 DAG 节点按 wave 通过 WorkspaceConcurrency 有界并行，依赖边保持串行；写 turn 必须使用独立 worktree，cleanup 必须以 command-scoped DeepAgent Git 身份产出 durable continuation ref，依赖 turn 从精确 ref 继续；创建隔离失败或无法证明 cleanup 已保留 commit 时 fail closed 并升级人工。AgentExecution 的 claim、lease、generation、resource lock、token debit 和 handoff 使用 SQLite durable state，并由真实 OS 进程测试跨进程竞争。

`v4-multi-agent-runtime` 是直接 V4 生产入口的真实模型回归：它通过 EventDispatcher、MultiAgentRuntime、真实 SessionPrompt/provider/tool loop 执行 `ci.failure` DAG，核验事件根 lineage、每个 turn 的 generation/token/terminal metadata、canonical worktree、依赖 continuation ref 和零权限等待。terminal leaf 有变更时必须从精确 ref 创建可恢复作者 worktree，把原 child Session relocation 到该目录，并以 `cleanupRequired: true` 进入同一 PR queue，同时产生一条 ApprovalQueue human event；重复 callback 不得重复入队。无 diff terminal leaf 不得切换父分支或创建 PR。真实 suite 到显式审批边界停止，不以模型自述冒充 merge。

审批后的完整闭环由直接生产状态机测试验证：Reviewer 首次返回 `request_changes` 后，使用原 `task_id` 恢复同一个 V4 child Session 和作者 worktree，重新提交到同一 PR；再次 `pr_finalize` 后绑定新 SHA 审阅、`--no-ff` merge、Senior Reviewer 和 worktree cleanup 全部完成。默认 V4 分区规则当前没有产生独立同 wave 节点，因此 V4 wave pool 的并行性使用确定性双 runner 同步屏障证明；真实模型并行性由 `multi-agent-parallel-worktrees` 和 `expert-panel` 覆盖，不能把两类证据混写。

### 5.5 Expert Panel 与缓存边界

`expert-panel` 必须并行创建 correctness、security、architecture 三个 Reviewer Session。每个 Reviewer 只能成功读取自己的目标文件，必须经过独立的 structured finalizer，并由确定性 arbiter 重算最终 verdict 和 dissent。Oracle 要求每个 lens 至少有一条命中预埋代码事实且置信度为 `0.95` 的 finding；额外 finding 只要仍受目标文件、类别、证据隔离和置信度范围约束，就不应被误判为产品故障。模型对未授权路径的额外 read 尝试可以存在，但必须由权限层拒绝；任何额外成功读取或其他工具调用都应失败。

普通同 Session Provider 轮次必须保持稳定 system prompt 和历史前缀。响应侧监控比较连续轮次的实际 `cache.read / prompt input` 比率和绝对 `cache.read`；只有 prompt 未缩短、命中率显著下降且缓存读取量也显著下降时，才报告疑似缓存崩溃。缓存读取量不变而新增未缓存尾部使比率下降，属于正常增长，不能误报为前缀崩溃。

structured finalizer 是显式新前缀：生产实现会主动裁掉研究历史并把工具集切换为唯一的 `StructuredOutput`，进入 finalizer 前必须重置响应侧缓存基线。compaction summary 同样在原 Session ID 下使用独立的 compaction Agent/system/tool 前缀，但它不得读取或覆盖普通会话的 system/响应监控基线；压缩后的首个普通轮次仍必须与压缩前最后一个普通轮次直接比较。以上隔离只消除跨请求类型假阳性，不得放宽普通对话、工具续轮、压缩续轮或计划热更新的稳定性约束。

## 6. 只运行不调用模型的前置检查

以下检查不需要 API key，也不会调用真实模型：

```sh
(cd packages/core && bun run test:llm-sandbox)
(cd packages/core && bun run test:llm-det:contracts)
(cd packages/deepagent-code && bun run test:llm-routes)
(cd packages/deepagent-code && bun run test:llm-det:contracts)
```

建议在真实模型测试前先运行这些命令。聚合 runner 也会先执行相应前置检查；如果前置检查失败，后续模型调用不会继续。

多 Agent 变更至少还要从 `packages/deepagent-code` 运行以下源码级回归：

```sh
bun test test/tool/task.test.ts test/tool/task-run.test.ts test/tool/task-takeover.test.ts test/tool/task-finalizer.test.ts
bun test test/agent/pr-collaboration.test.ts test/agent/pr-queue.test.ts test/agent/pr-queue-process.test.ts test/tool/pr-finalize.test.ts
bun test test/session/agent-worktree.test.ts test/session/multi-agent-runtime.test.ts test/session/agent-handoff-consumer.test.ts
bun test test/session/v4-event-runtime.test.ts test/session/v4-integration.test.ts test/session/v4-pr-collaboration.test.ts test/session/session.test.ts
bun test test/script/live-llm-routes.test.ts test/script/run-live-llm-all.test.ts
bun typecheck
```

AgentExecution 变更还必须从 `packages/core` 运行：

```sh
bun test test/agent-execution.test.ts test/agent-execution-process.test.ts test/event-router.test.ts test/database-migration.test.ts
bun typecheck
```

这些测试必须直接调用生产实现。允许注入 runner/provider/partition 边界来制造超时、崩溃和并行 DAG，但不得在测试中复制 task、调度器、PR queue、worktree cleanup 或 durable generation 的实现逻辑。V4 并行测试必须使用两个 runner 共同到达的同步屏障，并断言依赖 runner 只在整个上游 wave 完成后启动；耗时比较不能作为并行 Oracle。

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
export DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE="$HOME/.deepagent/code/live-llm-deepseek.key"
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
