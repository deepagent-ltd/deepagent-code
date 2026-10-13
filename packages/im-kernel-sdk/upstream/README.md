<div align="center">
  <img src="res/logo.png" alt="JuggleIM" width="120" />

  <h1>JuggleIM Web SDK</h1>

  <p><strong>A high-performance, open-source real-time messaging SDK for the Web.</strong><br/>
  Built on a custom binary protocol over WebSocket. Powers chat, group, live chatroom, RTC signaling and moments out of the box.</p>

  <p>
    <a href="https://github.com/Juggleim/im-web-sdk"><img src="https://img.shields.io/github/stars/Juggleim/im-web-sdk?style=social" alt="GitHub Stars"/></a>
    <a href="https://github.com/Juggleim/im-web-sdk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Juggleim/im-web-sdk" alt="License"/></a>
    <a href="https://www.npmjs.com/package/webim-sdk"><img src="https://img.shields.io/npm/v/webim-sdk" alt="npm Version"/></a>
    <a href="https://www.npmjs.com/package/webim-sdk"><img src="https://img.shields.io/npm/dw/webim-sdk" alt="npm Downloads"/></a>
    <a href="https://github.com/Juggleim/im-web-sdk/actions"><img src="https://img.shields.io/github/actions/workflow/status/Juggleim/im-web-sdk/release.yml" alt="Build Status"/></a>
  </p>

  <p>
    <a href="#-features">Features</a> ·
    <a href="#-quick-start">Quick Start</a> ·
    <a href="#-documentation">Docs</a> ·
    <a href="#-ecosystem">Ecosystem</a> ·
    <a href="#-community">Community</a>
  </p>

  <p>
    English | <a href="./README.zh-CN.md">简体中文</a>
  </p>
</div>

---

## Why JuggleIM?

Building reliable, large-scale real-time messaging from scratch is hard. **JuggleIM** is a complete, production-grade IM platform with server, admin and multi-platform clients. This repository hosts the **official Web SDK** that lets you ship chat features in minutes — without giving up control of your protocol, your data or your infrastructure.

- Custom binary protocol — Protobuf over WebSocket, optimized for low latency and small payload.
- Auto-reconnect & resend — Survives flaky networks with offline messages, ACK and retransmission.
- Composable architecture — One unified client API for chat, group, chatroom, moments and RTC signaling.
- Web & Desktop — Same API works in browsers and Electron-based desktop apps.
- Tiny runtime — No framework lock-in, no heavy deps. Tree-shakable ESM + minified UMD bundles.

## ✨ Features

- Connection management — Multi-entry server list, smart failover, keep-alive heartbeat, exponential backoff reconnect.
- One-to-one chat — Text, image, file, audio, video, custom messages. Read receipts & typing indicators.
- Group chat — Member management, @mention, mute, role permissions, message recall, quoted reply.
- Chatroom (live) — Join/leave, member count, mute-all, broadcast, custom attributes, ideal for live streaming & events.
- Conversations — Pin, mute, mark unread, tag, draft, server-side ordering, multi-conversation types.
- Messages — Send/receive, history, search, recall, delete, forward, merge, custom message types registration.
- Moments (social feed) — Post, comment, like, timeline.
- RTC signaling — Invite, accept, hangup, busy, custom signaling for audio/video calls.
- User presence & unread — Online status, custom status, multi-tag unread count.
- Offline & push — Offline messages, third-party push channel integration.
- Events & listeners — Rich event system for messages, connections, conversations, presence and more.
- TypeScript first — Bundled `.d.ts`, full type safety out of the box.

## 🚀 Quick Start

### Install

```bash
npm install jugglechat-websdk
# or
yarn add jugglechat-websdk
# or
pnpm add jugglechat-websdk
```

### Initialize

```js
import JuggleIM from 'jugglechat-websdk';

const client = new JuggleIM({
  appkey: 'YOUR_APP_KEY',
  serverList: ['wss://im-api.juggle.im/websocket'],
  upload: {
    type: 'qiniu',           // or 'aliyun', 'aws', 'custom'
    // upload config...
  },
  log: { level: 'info' }
});
```

### Connect & send a message

```js
// Connect with a server-issued token
await client.connect({ token: 'USER_TOKEN', deviceId: 'optional' });

// Listen for incoming messages
client.on(client.Event.MESSAGE_RECEIVED, (message) => {
  console.log('New message:', message);
});

// Send a text message
await client.sendMessage({
  type: client.MessageType.TEXT,
  targetId: 'TARGET_USER_ID',
  conversationType: client.ConversationType.PRIVATE,
  content: { text: 'Hello from JuggleIM 👋' }
});
```

### Create or join a chatroom

```js
await client.chatroom.join({ chatroomId: 'live-room-001', autoJoin: true });
client.on(client.Event.MESSAGE_RECEIVED, (msg) => {
  // handle chatroom message
});
```

> A complete React/Vue demo lives at **[Juggleim/web-im-demo](https://github.com/Juggleim/web-im-demo)** — clone, run, ship.

## 🏗️ Architecture

```
┌──────────────────┐         ┌─────────────────────┐
│  Your Web App    │  HTTPS  │  JuggleIM Server    │
│  (React/Vue/…)   ├────────▶│  (REST: token,      │
│                  │         │   user, group, msg)  │
│  ┌────────────┐  │  WSS    │                     │
│  │ webim-sdk  │◀─┼────────▶│  WebSocket Gateway  │
│  └────────────┘  │ Protobuf│  (msg push, ACK,    │
│                  │         │   presence, RTC)    │
└──────────────────┘         └─────────────────────┘
```

The SDK is structured as: **Socket Layer (transport + protocol)** → **Provider Layer (chat / group / chatroom / moment / signal)** → **Public API (unified client)**.

## 🌐 Browser Compatibility

Supports modern browsers and IE 11+ via polyfills. See [`res/cpb.png`](./res/cpb.png) for the full compatibility matrix.

| Browser | Version |
| ------- | ------- |
| Chrome  | 80+     |
| Edge    | 80+     |
| Firefox | 78+     |
| Safari  | 14+     |
| Electron| 18+     |

## 📚 Documentation

- Official docs: <https://www.juggle.im/>
- API reference: [`src/index.d.ts`](./src/index.d.ts)
- Examples & recipes: [Juggleim/web-im-demo](https://github.com/Juggleim/web-im-demo)
- Release notes: <https://github.com/Juggleim/im-web-sdk/releases>

## 🌱 Ecosystem

| Project | Description |
| ------- | ----------- |
| [im-web-sdk](https://github.com/Juggleim/im-web-sdk) | **This repo** — Web SDK |
| [im-server](https://github.com/Juggleim/im-server) | Self-hosted IM backend |
| [im-admin](https://github.com/Juggleim/im-admin) | Admin console |
| [im-android-sdk](https://github.com/Juggleim/im-android-sdk) | Android SDK |
| [im-ios-sdk](https://github.com/Juggleim/im-ios-sdk) | iOS SDK |
| [web-im-demo](https://github.com/Juggleim/web-im-demo) | React/Vue integration demo |

## 🤝 Contributing

We love contributions! Whether it's:

- Reporting a bug via [Issues](https://github.com/Juggleim/im-web-sdk/issues)
- Proposing a feature in [Discussions](https://github.com/Juggleim/im-web-sdk/discussions)
- Improving docs or examples
- Sending a [Pull Request](https://github.com/Juggleim/im-web-sdk/pulls)

Please read **[CONTRIBUTING.md](./CONTRIBUTING.md)** first.

## 💬 Community

Have questions or want to chat with other JuggleIM developers? Join us:

- Telegram Group: <https://t.me/juggleim_zh>


## 📄 License

Copyright © JuggleIM. Licensed under the **[Apache License 2.0](./LICENSE)**.

---

<sub>Built with ❤️ by the JuggleIM team and contributors.</sub>
