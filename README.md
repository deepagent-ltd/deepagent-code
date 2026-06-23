<p align="center">
  <a href="https://deepagent-code.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="DeepAgent Code logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://deepagent-code.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/deepagent-code"><img alt="npm" src="https://img.shields.io/npm/v/deepagent-code?style=flat-square" /></a>
  <a href="https://github.com/lessweb/deepagent-code/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/lessweb/deepagent-code/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![DeepAgent Code Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://deepagent-code.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://deepagent-code.ai/install | bash

# Package managers
npm i -g deepagent-code@latest        # or bun/pnpm/yarn
scoop install deepagent-code             # Windows
choco install deepagent-code             # Windows
brew install anomalyco/tap/deepagent-code # macOS and Linux (recommended, always up to date)
brew install deepagent-code              # macOS and Linux (official brew formula, updated less)
sudo pacman -S deepagent-code            # Arch Linux (Stable)
paru -S deepagent-code-bin               # Arch Linux (Latest from AUR)
mise use -g deepagent-code               # Any OS
nix run nixpkgs#deepagent-code           # or github:lessweb/deepagent-code for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

DeepAgent Code is also available as a desktop application. Download directly from the [releases page](https://github.com/lessweb/deepagent-code/releases) or [deepagent-code.ai/download](https://deepagent-code.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `deepagent-code-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `deepagent-code-desktop-mac-x64.dmg`     |
| Windows               | `deepagent-code-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask deepagent-code-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/deepagent-code-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$DEEPAGENT_CODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.deepagent-code/bin` - Default fallback

```bash
# Examples
DEEPAGENT_CODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://deepagent-code.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://deepagent-code.ai/install | bash
```

### Agents

DeepAgent Code includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://deepagent-code.ai/docs/agents).

### Documentation

For more info on how to configure DeepAgent Code, [**head over to our docs**](https://deepagent-code.ai/docs).

### Contributing

If you're interested in contributing to DeepAgent Code, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on DeepAgent Code

If you are working on a project that's related to DeepAgent Code and is using "deepagent-code" as part of its name, for example "deepagent-code-dashboard" or "deepagent-code-mobile", please add a note to your README to clarify that it is not built by the DeepAgent Code team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/deepagent-code) | [X.com](https://x.com/deepagent-code)
