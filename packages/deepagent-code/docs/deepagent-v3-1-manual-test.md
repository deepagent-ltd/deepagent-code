# DeepAgent V3.1 人工测试文档

本文档面向**人工 UI 测试**。它列出在能运行 DeepAgent Code 应用的环境里需要手动验证的功能——这些功能依赖真实模型、真实编辑、真实 git 和浏览器 UI，自动化测试覆盖不到或只覆盖了后端。

> 自动化部分（单测/typecheck）请看 §0 与旧文档 `deepagent-v3-manual-test.md`。本文件只讲 **V3.1 新增/改动**需要人工确认的东西。
>
> 复跑时以当前终端输出和当前 git 工作树为准，不要沿用文中任何历史数字。

---

## 0. 先跑自动化（确认基线干净）

```bash
# 仓库根：deepagent-code
cd packages/llm           && bun test && bun run typecheck
cd ../deepagent-code      && bun test test/deepagent/ && bun run typecheck
cd ../app                 && bun run typecheck && bun test --preload ./happydom.ts ./src
```

验收：三包 typecheck 通过；llm / deepagent / app 测试全绿（`prompt.test.ts` 的 `glob tool keeps instance context` 偶发并发超时属已知 flaky，隔离重跑通过，可忽略）。

---

## 0.5 如何启动应用进行测试

> 要求：Bun 1.3+。所有命令在**仓库根目录** `deepagent-code/` 执行。本文档大部分功能（情景 toggle、wish 审阅、设置页强度、reviewer 页）都需要**浏览器 Web UI**，所以推荐"服务端 + Web 应用"两段式启动。

**第一步：安装依赖（仅首次）**

```bash
bun install
```

**方式 A（推荐，一条命令起服务端 + 打开 Web UI）**

```bash
bun dev web
```

这会启动 DeepAgent Code 服务端并打开 Web 界面。

**方式 B（分两步，便于看服务端日志 / 调 UI 热更新）**

```bash
# 终端 1：起 headless API 服务端（默认端口 4096）
bun dev serve
#   端口被占用可改： bun dev serve --port 8080

# 终端 2：起 Web 应用（Vite，默认 http://localhost:5173）
bun run --cwd packages/app dev
```

然后浏览器打开终端 2 输出的地址（通常 `http://localhost:5173`）。**服务端必须一直开着**，否则 UI 没有后端功能。

**指定工作目录**：默认在 `packages/deepagent-code` 目录下跑;要对某个具体仓库/目录测试：

```bash
bun dev web <目标目录的绝对路径>
# 或对本仓库根自身： bun dev web .
```

**进入会话**：在 UI 里打开一个工作目录 → 新建/进入会话 → 在右下角输入框测试本文档各项。

**配置 provider / 模型**：首次需在设置页连接一个上游 provider（OpenAI / DeepSeek / Anthropic）并填 API key,否则真实模型相关项（wish 补全、多轮、知识）无法跑。

**切换 agent 强度**：设置页（general / high / max / ultra）。**切换情景模式**：输入框发送键左侧的 toggle（direct / wish）。

> 提示：很多项依赖真实模型调用，请确保 provider 已连且网络可用;否则 wish 会走启发式回退（见 §三 2.6）。

---

## 一、最重要：四件事如何配合（V3.1 核心心智模型）

V3.1 把"对用户可见的控制"收敛成**两个**：

- **情景模式**（发送键左侧的 toggle）：`direct`（你自己写 prompt）/ `wish`（DeepAgent 帮你准备 prompt 并在后续给下一轮建议）。**每轮可切**。
- **agent 强度**（设置页）：`general → high → max → ultra`，单调递增，每档只多加一件事。

另外两件事**不是用户开关**，由强度自动推导：
- **多轮 workflow**（微轮自修复 / 宏轮提下一目标）——`high` 及以上自动开。
- **知识检索**——`max`、`ultra` 才开。

测试时请始终带着这张表对照：

| 强度 | 比上一档多了什么 | 知识 | 自动多轮 | 宏轮谁批准 |
|---|---|---|---|---|
| general | —（最轻，单轮，行为≈原版 opencode） | 关 | 无 | —（用户自己发下一条） |
| high | 控制面 artifacts + 自动微轮自修复 | 关 | 有 | 人点"继续" |
| max | + durable 知识检索 | 开 | 有 | 人点"继续" |
| ultra | + 自治（监督线程自动推进宏轮） | 开 | 有 | **监督线程自动** |

---

## 二、情景模式 toggle（D1）

**目的**：验证发送键左侧的情景 toggle 存在、可切换、且真的改变这一轮的提交行为。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1.1 | 打开一个工作目录，看输入框右下角发送键**左边** | 有一个情景 toggle 图标（铅笔=direct / 对话气泡=wish），hover 有中文提示"情景模式：直接/许愿 …" |
| 1.2 | 点击 toggle | 在 `direct` ↔ `wish` 间切换；图标和 tooltip 跟着变 |
| 1.3 | 切到 `direct`，输入一句话发送 | 直接发送，不弹任何"准备 prompt"的中间步骤 |
| 1.4 | 切到 `wish`，输入一句话发送 | 进入 wish 流程（见 §三）；不是直发 |
| 1.5 | **新建会话**（还没发第一条）就先切 toggle，再发第一条 | 第一条就按你切的模式走（toggle 在会话创建前设置也生效） |

验收：toggle 可见、可切、每轮生效，且新会话首轮也认你的选择。

---

## 三、wish 第一轮：AI 补全 prompt + 人审（A2 + D2）

**目的**：验证 wish 第一轮**真的调模型**把粗略需求补成完整可执行 prompt，把 AI 的推断**显式列出**让你审阅，且**先回到你面前、你确认后才发**。

> 前提：情景模式 = `wish`（§二）。强度 high 或以上更能看出区别。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 2.1 | 输入一句**粗略**需求（例："给项目加个登录"），点发送 | 输入框/会话进入"意见生成中"忙碌态（不是卡死），稍候出现准备好的 prompt 供审阅 |
| 2.2 | 看准备好的 prompt 内容 | 是一段**完整、可直接执行**的 prompt（补全了缺口），不是把你原话原样塞回去 |
| 2.3 | 看 prompt 里的"假设/Assumptions"部分 | AI 替你补的每个推断（例："用 JWT"、"加到现有 /auth 路由"）都**显式列出**，可以逐条看到 |
| 2.4 | 修改其中一条不对的假设/目标，再确认发送 | 你改的内容进入正式任务，不是原始那版 |
| 2.5 | 在审阅界面点取消 | 不提交任务，回到可编辑状态 |
| 2.6 | （故障注入，可选）断网或让模型不可用，再发 wish | 不应崩溃；回退到启发式准备的 prompt，仍可审阅（fail-soft） |

验收：wish 第一轮产出的是模型补全的完整 prompt + 显式假设；人审/可改/确认后才提交；模型不可用时优雅降级。

---

## 四、agent 强度分层（C4 / 知识门）

**目的**：验证四档强度行为正确分层，尤其 `general` 不拖累基线、知识只在 max/ultra 开。

> run 目录在 `~/.deepagent/code/runs/`（或配置的 runs 目录），每个 run 一个文件夹。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 3.1 | 设置页选 `general`，跑一个普通编码请求 | 行为≈原版 opencode；**不产生**控制面 artifacts；run 目录不长东西 |
| 3.2 | 切 `high` 跑同一类请求 | 系统提示头部出现 DeepAgent 标识；run 目录产生控制面 artifacts；**不注入 durable 知识** |
| 3.3 | 切 `max` 跑一个 GPU/CUDA 类请求 | `KNOWLEDGE_RETRIEVAL_RESULT.json` 出现策略/方法 refs，带 `evidence_strength`、`do_not_use_refs`/`gap_analysis` |
| 3.4 | 设置页确认有 `ultra` 选项可选 | 下拉里能看到 `general/high/max/ultra` 四档 |

验收：四档可选；general 纯透传零 artifacts；知识只在 max/ultra 出现。

---

## 五、自动多轮：微轮 vs 宏轮（A3）

**目的**：验证 high 以上的两层"轮"——微轮自动自修复（对人不可见）、宏轮提下一目标（需批准）。

> 多轮默认开启；若环境设了 `DEEPAGENT_MULTIROUND=0` 会退回单轮（fail-closed 调试开关）。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 4.1 | `high` 跑一个**带验证命令**的任务（仓库有 typecheck/test），故意让首次产出验证失败 | 系统**自动**跑验证→失败→诊断→再修一轮（微轮，你视角上还是"一轮内"）；最多若干轮；失败回滚到干净/最佳状态 |
| 4.2 | 当前目标收敛后 | 产生一条"下一轮建议"（`{status, body}`），`status=continue` 时等你点"继续"（high/max 需人批准） |
| 4.3 | 观察 git 工作区 | 失败轮不把工作区留在破损状态 |
| 4.4 | 故意让模型自报"测试通过"但实际验证失败 | 系统以 **runner 实测**为准，识别出"声明与实测不一致"，不会误判完成（status 倾向 needs_human） |

验收：微轮自动修复；宏轮建议由**客观实测**决定而非模型自报；high/max 的宏轮等人批准。

---

## 六、ultra 自治（监督线程）

**目的**：验证 ultra 在 wish + 多轮下能**无人值守自动推进**宏轮直到收敛，并在该停时升级给人。

> ultra 依赖 wish 建议机制，请把情景模式设为 `wish`。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 5.1 | 强度 `ultra` + 情景 `wish`，给一个需要多步的任务 | 自动跑：执行→验证→（收敛则）自动用 wish 建议播种下一宏轮→再执行……无需你每轮点继续 |
| 5.2 | 观察停止条件 | 收敛（done）、反复无进展、预算上限、或歧义（needs_human）时停下；不会无限烧 |
| 5.3 | 与 max 对比 | 同样任务在 `max` 下，每个宏轮会**停下等你点继续**；`ultra` 不停 |

验收：ultra 自动推进宏轮并能正确收敛/升级；max 仍需人批准——两者差别就在"谁批准宏轮"。

---

## 七、停止 → 回到 direct（D3，fail-safe）

**目的**：验证任何"停止"都把情景重置为 `direct` 并暂停自动化，直到你下一条消息。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 6.1 | 在 `wish`（或 ultra 自动跑）过程中点停止 | 任务停下；情景 toggle 回到 `direct` |
| 6.2 | 停止后直接再发一条消息 | 这一条按 `direct` 直发，不再自动进入 wish/多轮，直到你重新切回 wish |

验收：停止 = 回到最简单可控的 direct 模式 + 暂停自动化。

---

## 八、Reviewer 复盘页 + 人审晋升（F4 / A7）

**目的**：验证能从 run artifacts 复盘"为何接受/回滚"，并能人审晋升知识。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 7.1 | 跑过几个 high/max run 后，浏览器访问 `/<dir>/review` | 左侧列出最近 run id |
| 7.2 | 点选一个 run | 右侧显示状态、候选谱系、诊断、accept/rollback 理由、可展开 RUN_CONTEXT |
| 7.3 | 对一个 staged 知识候选点"晋升/promote" | 该候选被加上 `promoted_at`，之后 max/ultra 任务可检索到它 |
| 7.4 | 对一个候选点"拒绝/reject" | 进入拒绝缓冲，不再被重新学习 |
| 7.5 | 反污染确认：未晋升的候选 | **不**出现在 `KNOWLEDGE_RETRIEVAL_RESULT.json` 的 selected_refs（只有人审晋升的才注入） |

验收：复盘页能投影决策理由；promote/reject 可用；未晋升候选永不被检索注入。

---

## 九、后台学习不拖累主流程（E1）

**目的**：验证学习在主任务线程**之外**跑，不阻塞当轮。

| 步骤 | 操作 | 期望 |
|---|---|---|
| 8.1 | 连续完成几个 high/max 任务 | 每轮结束很快返回，不因"学习"卡顿；学习在后台异步发生 |
| 8.2 | 完成后检查项目记忆 | 安全的项目本地记忆自动并入 project memory；需审的（策略/反模式/敏感）进 memory inbox 等人审 |

验收：学习异步发生、不阻塞当轮；安全候选自动并入、需审候选进 inbox。

---

## 十、回归确认（务必）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 9.1 | `general` + `direct` 正常用一段时间 | 与原版 opencode 完全一致，无任何 DeepAgent 干预，无多余 artifacts |
| 9.2 | 切到任意上游 provider（OpenAI/DeepSeek/Anthropic）在 high 下跑 | DeepAgent 对**所有 provider** 生效（控制面 artifacts 正常产出）；provider 的 auth/streaming/工具/MCP/审批语义不变 |
| 9.3 | 触发内部 kill switch（如设置）| 命中 DeepAgent 的请求 **fail-closed**（明确报错），不是静默旁路 |

验收：general 不拖累基线；DeepAgent 全局生效但不破坏 provider 既有能力；kill switch 真正 fail-closed。

---

## 附：本轮（V3.1）重点改动速查

- 情景模式收敛为 `direct`/`wish`（移除 `design`）；发送键左侧 toggle，wish 默认。
- agent 强度新增 `ultra`（= max + 自治监督线程）。
- wish 第一轮真调模型补全 prompt + 显式 assumptions + 人审后才发。
- 多轮拆成"微轮（自动自修复）/ 宏轮（提下一目标，需批准；ultra 自动批准）"。
- round_report 用 **runner 实测**对账模型声明，收敛与否客观判定。
- 全局运行时：激活按**强度**而非 provider，DeepAgent 对所有 provider 生效。
- 后台学习 worker 队列化，移出主任务线程。
- kill switch 改为真正 fail-closed。
