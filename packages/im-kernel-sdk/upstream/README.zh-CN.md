<div align="center">
  <img src="res/logo.svg" alt="JuggleIM" width="120" />

  <h1>JuggleIM Web SDK</h1>

  <p><strong>高性能、可扩展的开源 Web 端实时通讯 SDK。</strong><br/>
  基于自研 Protobuf/WebSocket 二进制协议，开箱即用地支持单聊、群聊、直播聊天室、RTC 信令与朋友圈。</p>

  <p>
    <a href="https://github.com/Juggleim/im-web-sdk"><img src="https://img.shields.io/github/stars/Juggleim/im-web-sdk?style=social" alt="GitHub Stars"/></a>
    <a href="https://github.com/Juggleim/im-web-sdk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Juggleim/im-web-sdk" alt="License"/></a>
    <a href="https://www.npmjs.com/package/webim-sdk"><img src="https://img.shields.io/npm/v/webim-sdk" alt="npm Version"/></a>
    <a href="https://www.npmjs.com/package/webim-sdk"><img src="https://img.shields.io/npm/dw/webim-sdk" alt="npm Downloads"/></a>
    <a href="https://github.com/Juggleim/im-web-sdk/actions"><img src="https://img.shields.io/github/actions/workflow/status/Juggleim/im-web-sdk/release.yml" alt="Build Status"/></a>
  </p>

  <p>
    <a href="#-功能特性">功能特性</a> ·
    <a href="#-快速开始">快速开始</a> ·
    <a href="#-文档">文档</a> ·
    <a href="#-生态">生态</a> ·
    <a href="#-社区">社区</a>
  </p>

  <p>
    <a href="./README.md">English</a> | 简体中文
  </p>
</div>

---

## 为什么选择 JuggleIM？

从零搭建一套可靠、海量的实时通讯系统并不容易。**JuggleIM** 是一套完整的、生产级的 IM 平台，包含服务端、运营后台以及多端客户端。本仓库是它的 **官方 Web SDK**，让你在几分钟内就能上线聊天功能，同时完整掌控自己的协议、数据与基础设施。

- 自研二进制协议：基于 Protobuf over WebSocket，针对低延迟与小包体积深度优化。
- 自动重连与重发：离线消息、ACK 应答、超时重传，弱网下依然稳定。
- 可组合架构：统一的客户端 API 同时覆盖单聊、群聊、聊天室、朋友圈、RTC 信令。
- Web 与桌面同源：同一套 API 同时运行于浏览器与基于 Electron 的桌面端。
- 极轻量：无框架锁定、无重型依赖，支持 Tree-shaking 的 ESM 与压缩后的 UMD 双产物。

## ✨ 功能特性

- **连接管理** — 多接入点服务列表、智能故障切换、保活心跳、指数退避重连。
- **单聊** — 文本、图片、文件、音频、视频及自定义消息；已读回执与输入状态。
- **群聊** — 成员管理、@提醒、全体禁言、角色权限、消息撤回、引用回复。
- **聊天室（直播）** — 加入/退出、在线人数、全员禁言、广播、自定义属性，适合直播与活动场景。
- **会话** — 置顶、免打扰、未读标记、标签、草稿、服务端排序、多会话类型。
- **消息** — 收发、历史拉取、搜索、撤回、删除、转发、合并、自定义消息类型注册。
- **朋友圈（动态）** — 发布、评论、点赞、时间线。
- **RTC 信令** — 邀请、接听、挂断、忙线、自定义信令，支持音视频通话。
- **在线状态与未读** — 在线/离线、自定义状态、多标签未读计数。
- **离线与推送** — 离线消息拉取与第三方推送通道对接。
- **事件与监听** — 丰富的消息、连接、会话、状态事件系统。
- **TypeScript 优先** — 内置 `.d.ts` 类型定义，开箱即用的完整类型安全。

## 🚀 快速开始

### 安装

```bash
npm install jugglechat-websdk
# 或
yarn add jugglechat-websdk
# 或
pnpm add jugglechat-websdk
```

### 初始化

```js
import JuggleIM from 'jugglechat-websdk';

const client = new JuggleIM({
  appkey: 'YOUR_APP_KEY',
  serverList: ['wss://im-api.juggle.im/websocket'],
  upload: {
    type: 'qiniu',           // 也支持 'aliyun'、'aws'、'custom'
    // upload config...
  },
  log: { level: 'info' }
});
```

### 连接与发送消息

```js
// 使用服务端下发的 token 建立连接
await client.connect({ token: 'USER_TOKEN', deviceId: 'optional' });

// 监听收到的消息
client.on(client.Event.MESSAGE_RECEIVED, (message) => {
  console.log('新消息：', message);
});

// 发送一条文本消息
await client.sendMessage({
  type: client.MessageType.TEXT,
  targetId: 'TARGET_USER_ID',
  conversationType: client.ConversationType.PRIVATE,
  content: { text: '来自 JuggleIM 的问候 👋' }
});
```

### 创建或加入聊天室

```js
await client.chatroom.join({ chatroomId: 'live-room-001', autoJoin: true });
client.on(client.Event.MESSAGE_RECEIVED, (msg) => {
  // 处理聊天室消息
});
```

> 完整的 React / Vue 示例仓库见 **[Juggleim/web-im-demo](https://github.com/Juggleim/web-im-demo)** —— clone、跑起来、上线。

## 🏗️ 架构

```
┌──────────────────┐         ┌─────────────────────┐
│  你的 Web 应用    │  HTTPS  │  JuggleIM 服务端    │
│ (React/Vue/原生)  ├────────▶│  (REST: token、    │
│                  │         │   用户、群、消息)    │
│  ┌────────────┐  │  WSS    │                     │
│  │ webim-sdk  │◀─┼────────▶│  WebSocket 网关      │
│  └────────────┘  │ Protobuf│  (消息推送、ACK、   │
│                  │         │   在线状态、RTC)     │
└──────────────────┘         └─────────────────────┘
```

SDK 自底向上分为三层：**Socket 层（传输 + 协议）** → **Provider 层（chat / group / chatroom / moment / signal）** → **对外 API（统一 client）**。

## 🌐 浏览器兼容性

兼容现代浏览器，并通过 polyfill 支持 IE 11+。完整兼容性矩阵见 [`res/cpb.png`](./res/cpb.png)。

| 浏览器 | 版本 |
| ------ | ---- |
| Chrome | 80+  |
| Edge   | 80+  |
| Firefox| 78+  |
| Safari | 14+  |
| Electron | 18+ |

## 📚 文档

- 官方文档：<https://www.juggle.im/>
- API 参考：[`src/index.d.ts`](./src/index.d.ts)
- 示例与教程：[Juggleim/web-im-demo](https://github.com/Juggleim/web-im-demo)
- 发布历史：<https://github.com/Juggleim/im-web-sdk/releases>

## 🌱 生态

| 项目 | 说明 |
| ---- | ---- |
| [im-web-sdk](https://github.com/Juggleim/im-web-sdk) | **本仓库** —— Web SDK |
| [im-server](https://github.com/Juggleim/im-server) | 可自托管的 IM 服务端 |
| [im-admin](https://github.com/Juggleim/im-admin) | 运营管理后台 |
| [im-android-sdk](https://github.com/Juggleim/im-android-sdk) | Android SDK |
| [im-ios-sdk](https://github.com/Juggleim/im-ios-sdk) | iOS SDK |
| [web-im-demo](https://github.com/Juggleim/web-im-demo) | React / Vue 集成示例 |

## 🤝 参与贡献

我们欢迎任何形式的贡献，包括但不限于：

- 通过 [Issues](https://github.com/Juggleim/im-web-sdk/issues) 反馈 Bug
- 在 [Discussions](https://github.com/Juggleim/im-web-sdk/discussions) 提交新功能建议
- 改进文档与示例
- 提交 [Pull Request](https://github.com/Juggleim/im-web-sdk/pulls)

请先阅读 **[CONTRIBUTING.md](./CONTRIBUTING.md)**。

## 💬 社区

有问题或想和其他 JuggleIM 开发者交流？欢迎加入：

- Telegram 社区：<https://t.me/juggleim_zh>

## 📄 许可证

Copyright © JuggleIM。基于 **[Apache License 2.0](./LICENSE)** 开源。

---

<sub>由 JuggleIM 团队与所有贡献者用 ❤️ 构建。</sub>
