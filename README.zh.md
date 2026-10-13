<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code 标志" width="520">
  </picture>
</p>

<p align="center"><strong>面向长期任务的 AI 编程工作区</strong></p>

<p align="center">代码、项目记忆、持续任务、浏览器与个人代理通信，在同一个工作区中协同。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code/releases">下载安装</a> |
  <a href="CHANGELOG.md">版本更新</a>
</p>

---

**DeepAgent Code（DAC）** 将桌面编程工作区和终端智能体连接到同一个执行内核。面对跨文件、多轮对话、多种工具和多人讨论的工作，你可以保留项目上下文、维护可编辑的计划、委派独立子任务、查看执行过程，并让最终回答回到发起工作的对话中。

当前源码面向 **2.0.4**。已提供的安装包以 [GitHub Releases](https://github.com/deepagent-ltd/deepagent-code/releases) 为准。

## 为什么选择 DAC

| 你的需求                   | DAC 提供的能力                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **持续推进复杂任务**       | 持久会话、可编辑目标和计划、执行中补充指令、后续任务排队，让工作跨多轮保持清晰。   |
| **减少重复交代背景**       | 可查看的项目记忆连接事实、决策、技能与执行证据，保留来源，并按规则进入模型上下文。 |
| **分工协作时保持掌控**     | 子智能体处理独立任务；持久任务记录保留状态，可写协作通过独立 worktree 隔离。       |
| **让代码与网页工作衔接**   | 桌面内置受控浏览器，把页面查看、授权交互和文件交换纳入当前任务。                   |
| **把讨论直接转成实际工作** | 在公网 IM 中使用 `/dac` 调用自己的本机 DAC，同一会话连续追问，最终回答返回原对话。 |
| **按项目选择模型和工具**   | GUI 与 TUI 共用内核；模型供应商、Skills、领域包和 MCP 按需接入。                   |

## 2.0.4 带来了什么

**IM 中的个人工作代理。** 用 `/dac` 将讨论交给自己的 DAC，使用原有的本机 Session、模型、工具与权限。命令和执行过程仅自己可见，最终回答回到 IM；同一对话的追问复用 Session。文件和图片附件的上限为 **每份 10 MiB**。

**桌面内置受控浏览器。** 在编程工作区中查看页面、切换标签，并执行已支持的页面操作。上传、下载、剪贴板等敏感操作具有明确授权和目标检查；可用操作取决于主机平台及其浏览器能力。

**可追踪的事件工作流。** 已配置的事件可以触发具有依赖关系的任务图，留下执行记录和结果。你可以追溯触发来源、当前步骤、完成情况，以及哪些结果需要进一步处理。

**更统一的工作区。** 模型与推理强度选择靠近输入区操作，协作模式移入设置，IM 可以单独选择模型。桌面构建在不同工作流中共用 Native 资产准备与包内校验流程。

完整的面向用户的变更见 [更新记录](CHANGELOG.md)。

## 为持续工作提供基础

### 保留意图的持久会话

用户输入先保存，再安排执行。DAC 工作时，你可以继续补充方向，指令在下一个安全的模型轮次边界接入；也可以把独立任务排队，等当前任务结束后执行。较长的工作可以使用目标和可编辑计划，记录推进过程。

持久化也让不确定状态可见。任务中断后，DAC 会区分已记录的工作与需要恢复确认的外部操作，不默认把结果不明的工具或模型调用重新执行一遍。

### 可查看、可管理的记忆和上下文

项目知识保留类型、作用域、状态、版本和来源引用。保存的决策与通过准入的经验可以在后续会话复用，你可以查看和修正这些内容。

上下文按预算组装。代码引用、项目记忆、执行文档、Skills 和领域知识按需要加载；稳定指令与不断变化的任务状态分开组织，以支持供应商缓存。实际 token 消耗取决于任务和模型。

### 有明确归属的任务协作

把独立的调研、实现和审查交给子智能体。持久任务记录保留归属、状态、结果和父任务通知；可写协作使用独立 worktree，并具有审查边界。

事件工作流为已配置的自动化增加依赖关系协调，用持久投递和可观察状态支撑交互执行之外的任务推进。

### 编程工具与可扩展生态

DAC 结合文件编辑、终端命令、基于 LSP 的代码导航、受控浏览器和项目知识。Skills 描述可重复的工作流程，领域包补充专业知识，MCP 将外部工具和资源接入同一个带权限控制的工作流。

连接已支持的官方供应商或配置兼容端点，按任务选择模型。模型和工具支持以供应商能力为准；IM 个人代理可以单独选择本机已配置的模型。

## 在 IM 中调用自己的代理

例如，与同事讨论一个问题时：

```text
/dac 检查当前项目的登录处理逻辑，修复失败用例，并运行相关测试。
```

DAC 打开或复用与这段对话关联的本机 Session。你可以在正常的 DAC 工作区中查看流式执行，最终回答随后回到 IM 对话。下一条 `/dac` 指令可以沿用同一 Session 继续工作；需要独立上下文时，也可以显式新建 Session。

IM 需要单独、显式激活：**1 credit，一次激活长期有效，不自动续费**。连接模型供应商不会自动激活 IM 或扣除激活费用。通过管理员或授权分发渠道获取凭据，在设置中激活 IM，再选择个人代理使用的模型。

公网 IM 负责消息通信，代理在你自己的电脑上执行。2.0.4 不提供公网远程执行中转、供他人调用的共享代理或全桌面 Computer Use。

## 开始使用

### 桌面应用

从 [GitHub Releases](https://github.com/deepagent-ltd/deepagent-code/releases) 下载适合你平台的安装包。打开 DAC，在设置中连接模型供应商，选择项目后开始对话。

### 从源码运行

使用根 `package.json` 固定的 Bun 版本：当前为 **Bun 1.4.2**。

```bash
git clone --branch 2.0.4 https://github.com/deepagent-ltd/deepagent-code.git
cd deepagent-code
bun install
```

在仓库根目录运行：

```bash
# 桌面工作区
bun run dev:desktop

# 终端界面
bun run dev

# Web UI 开发服务
bun run dev:web
```

执行一次性任务，或在导入历史前预览：

```bash
bun run --cwd packages/deepagent-code dev run "查找并修复失败的登录测试"
bun run --cwd packages/deepagent-code dev import-history --from codex --dry-run
```

独立 Web UI 需要运行中的 DAC 后端；Web UI 指南给出了两个开发服务的启动方式。

各包的开发和构建说明见 [Desktop 指南](packages/desktop/README.md)、[Web UI 指南](packages/app/README.md) 和 [CLI/server 指南](packages/deepagent-code/README.md)。

### 连接模型

在 **设置 → 供应商** 中连接可用供应商，或者填写兼容端点的 Base URL 和 API Key。根据当前任务选择模型和推理强度。[DeepAgent API 平台](https://api.deepagent.ltd/) 是已支持的选项之一，也可以使用你自己的其他供应商凭据。

已安装的终端应用可以使用：

```bash
deepagent auth login
deepagent auth list
deepagent-code
```

macOS 和 Linux 的配置与本地状态保存在 `~/.deepagent/code/`。Windows 配置保存在 `%APPDATA%\deepagent-code`，数据保存在 `%LOCALAPPDATA%\deepagent-code`。模型凭据按供应商认证路径保存，MCP secret 引用在可用时使用系统凭据存储；凭据、工具权限和对外操作在各自执行边界接受检查。

## 文档与贡献

- [公开架构概览](design/README.md)
- [版本更新](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [隐私政策](PRIVACY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [公开文档站点源码](packages/web/src/content/docs)

## 许可证与来源

DeepAgent Code 使用 **AGPL-3.0-or-later** 许可证，完整条款见 [LICENSE](LICENSE)。

DAC 基于 [opencode](https://github.com/sst/opencode) 等开源组件开发。原始许可证和来源声明保留在 [NOTICE](NOTICE) 及对应软件包中。上游项目及其贡献者未为 DAC 背书。

<p align="center"><sub>Built by DeepAgent</sub></p>
