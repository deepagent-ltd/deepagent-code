<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>以文档系统为中心、带持久控制面的 AI 编程代理。</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## DeepAgent Code 是什么？

DeepAgent Code 是一个以持久文档系统为核心的 AI 编程代理。它保留 opencode 成熟的 runtime、tool、MCP、session 和 provider 基础，并在其上加入 DeepAgent 控制面：文档记忆、上下文组装、检索门控、自学习、失败诊断、领域适配器与运行时智能层。

核心思想很简单：文档系统是代理的持久身体。知识、策略、方法论、技能、记忆、诊断、决策、工作日志和上下文快照都被表示为带类型的文档。上下文层在每次模型调用前选择最小但足够有用的文档切片，并把新的证据写回文档图谱。

DeepAgent Code 不是 opencode 官方背书的上游版本，而是基于 opencode 的衍生作品，并包含大量 DeepAgent 修改与新增能力。

## 主要能力

- **文档图谱**：用带类型的文档表达持久知识、工作记忆、决策、诊断、快照、技能和方法论。
- **上下文控制**：在安全的 provider turn 边界做确定性上下文准入，限制工具输出，按证据检索，并处理记忆冲突。
- **工作强度**：`general`、`high`、`xhigh`、`max`、`ultra` 构成能力阶梯；高强度只增加控制面能力，不暗改低强度契约。
- **场景模式**：`direct` 直接执行用户提示；`wish` 先细化并确认意图，再进入更强的自动化。
- **AI IDE 微服务**：提供基于 LSP 风格的符号搜索、诊断和源码导航入口。
- **预置 MCP Catalog**：内置 Git 平台、文件搜索、只读数据库、浏览器/抓取等方向的 MCP server 预置。
- **学习生命周期**：完成任务后可生成候选记忆、事实、失败档案、策略和方法论，并经过证据与审批门控。

## 安装

```bash
npm i -g deepagent-code@latest
# 或
bun add -g deepagent-code
```

运行：

```bash
deepagent-code
# 别名：
deepagent
```

本仓库还包含 app、server、SDK、TUI、desktop shell 与支撑服务等包。

## 快速开始

```bash
# 在当前仓库启动代理
deepagent-code

# 带提示启动
deepagent-code "inspect this repo and explain the architecture"
```

常用本地开发命令：

```bash
bun install
bun run typecheck
bun run --cwd packages/deepagent-code test
bun run dev
```

## 多语言支持

应用 UI 已接入国际化。仓库中官方维护的 README 只有：

- [English](README.md)
- [简体中文](README.zh.md)

产品内可能存在更多 UI 翻译，但除非明确标注为官方维护，本仓库不再维护其他语言 README，以避免长期不同步。

## 安全与 MCP 凭据

DeepAgent Code 包含预置 MCP catalog。风险等级在运行时从 catalog 模板结构派生，而不是信任用户可写配置。只读数据库预置默认更保守，并包含 SQL guardrail。

V3.4.1 已知限制：启用需要凭据的预置 MCP server 时，凭据值可能被写入本地配置文件。不要把含密钥的配置提交到版本库。计划中的 V3.5 M-CRED 会把凭据迁移到操作系统级 secret storage，并在运行时通过环境变量解析。

漏洞报告、安全模型说明与源码获取方式见 [SECURITY.md](SECURITY.md)。

## 源码可得性与许可证

DeepAgent Code 使用 **AGPL-3.0-or-later** 许可证。如果你通过网络与基于 DeepAgent Code 的修改版服务交互，AGPL 的网络使用条款赋予你获取该服务对应源码的权利。

本项目派生自 [opencode](https://github.com/sst/opencode)，其上游许可证为 MIT。上游 MIT notice 与来源声明保留在 [NOTICE](NOTICE)。此声明不表示 opencode 或其贡献者为 DeepAgent Code 背书。

## 项目状态

V3.4.1 是首个公开发布前的加固里程碑：许可证与来源声明清理、文档收敛、secret 扫描基线、安全披露与 rebrand 核对，均需在第一个公开 tag 前完成。
