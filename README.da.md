<p align="center">
  <a href="https://deepagent-code.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="DeepAgent Code logo">
    </picture>
  </a>
</p>
<p align="center">Den open source AI-kodeagent.</p>
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

# Pakkehåndteringer
npm i -g deepagent-code@latest        # eller bun/pnpm/yarn
scoop install deepagent-code             # Windows
choco install deepagent-code             # Windows
brew install anomalyco/tap/deepagent-code # macOS og Linux (anbefalet, altid up to date)
brew install deepagent-code              # macOS og Linux (officiel brew formula, opdateres sjældnere)
sudo pacman -S deepagent-code            # Arch Linux (Stable)
paru -S deepagent-code-bin               # Arch Linux (Latest from AUR)
mise use -g deepagent-code               # alle OS
nix run nixpkgs#deepagent-code           # eller github:lessweb/deepagent-code for nyeste dev-branch
```

> [!TIP]
> Fjern versioner ældre end 0.1.x før installation.

### Desktop-app (BETA)

DeepAgent Code findes også som desktop-app. Download direkte fra [releases-siden](https://github.com/lessweb/deepagent-code/releases) eller [deepagent-code.ai/download](https://deepagent-code.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `deepagent-code-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `deepagent-code-desktop-mac-x64.dmg`     |
| Windows               | `deepagent-code-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, eller AppImage     |

```bash
# macOS (Homebrew)
brew install --cask deepagent-code-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/deepagent-code-desktop
```

#### Installationsmappe

Installationsscriptet bruger følgende prioriteringsrækkefølge for installationsstien:

1. `$DEEPAGENT_CODE_INSTALL_DIR` - Tilpasset installationsmappe
2. `$XDG_BIN_DIR` - Sti der følger XDG Base Directory Specification
3. `$HOME/bin` - Standard bruger-bin-mappe (hvis den findes eller kan oprettes)
4. `$HOME/.deepagent-code/bin` - Standard fallback

```bash
# Eksempler
DEEPAGENT_CODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://deepagent-code.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://deepagent-code.ai/install | bash
```

### Agents

DeepAgent Code har to indbyggede agents, som du kan skifte mellem med `Tab`-tasten.

- **build** - Standard, agent med fuld adgang til udviklingsarbejde
- **plan** - Skrivebeskyttet agent til analyse og kodeudforskning
  - Afviser filredigering som standard
  - Spørger om tilladelse før bash-kommandoer
  - Ideel til at udforske ukendte kodebaser eller planlægge ændringer

Derudover findes der en **general**-subagent til komplekse søgninger og flertrinsopgaver.
Den bruges internt og kan kaldes via `@general` i beskeder.

Læs mere om [agents](https://deepagent-code.ai/docs/agents).

### Dokumentation

For mere info om konfiguration af DeepAgent Code, [**se vores docs**](https://deepagent-code.ai/docs).

### Bidrag

Hvis du vil bidrage til DeepAgent Code, så læs vores [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygget på DeepAgent Code

Hvis du arbejder på et projekt der er relateret til DeepAgent Code og bruger "deepagent-code" som en del af navnet; f.eks. "deepagent-code-dashboard" eller "deepagent-code-mobile", så tilføj en note i din README, der tydeliggør at projektet ikke er bygget af DeepAgent Code-teamet og ikke er tilknyttet os på nogen måde.

---

**Bliv en del af vores community** [Discord](https://discord.gg/deepagent-code) | [X.com](https://x.com/deepagent-code)
