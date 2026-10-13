# Contributing to JuggleIM Web SDK

First off, thank you for considering contributing to **JuggleIM**! 🎉
You are helping build a faster, more reliable real-time messaging platform for everyone.

This document is a guideline, not a rulebook. Use your best judgment, and feel free to propose improvements via a PR.

---

## 📜 Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).
By participating, you are expected to uphold this code. Please report unacceptable behavior to <support@juggle.im>.

---

## 🐛 Reporting Bugs

Before opening a bug report, please:

1. **Search** [existing issues](https://github.com/Juggleim/im-web-sdk/issues) to avoid duplicates.
2. Update to the **latest version** — the bug may already be fixed.
3. Reproduce it on the **smallest possible example** (CodeSandbox / StackBlitz link preferred).

When filing an issue, include:

- SDK version (`npm ls webim-sdk` or `client.getVersion()`)
- Browser & OS, plus framework (React/Vue/vanilla) and version
- Expected vs. actual behavior
- Minimal reproduction (code snippet, screenshots, console logs)
- Server-side logs or correlation id (if available)

---

## 💡 Suggesting Features

We use [GitHub Discussions → Ideas](https://github.com/Juggleim/im-web-sdk/discussions/categories/ideas) for feature requests.

A great feature request answers:

- **What** problem are you trying to solve?
- **Why** can't you solve it today with the existing API?
- **How** would the ideal API look? (Pseudo-code is awesome)
- **Who** else benefits? (Use cases)

---

## 🔧 Submitting a Pull Request

### Workflow

1. Fork the repo and create a topic branch:
   ```bash
   git checkout -b feat/your-feature
   # or
   git checkout -b fix/issue-123
   ```
2. Install deps: `npm install`
3. Make your changes.
4. Run the build locally: `npm run release` (ensure it completes without errors).
5. Commit with a clear message (see below).
6. Push and open a PR against `main`.
7. Wait for CI ✅ and address review feedback.

### Commit Messages

We follow **Conventional Commits** (enforced lightly):

```
feat: add custom message type registration helper
fix(sdk): prevent duplicate reconnect attempts
docs: clarify token refresh flow
refactor(socket): extract heartbeat into a single module
test: cover chatroom join edge cases
chore: bump protobufjs to 7.3.0
```

### Coding Style

- ES module syntax (`import` / `export`).
- 2-space indentation, single quotes, semicolons.
- Prefer small, focused modules under `src/`.
- Public API changes **must** update [`src/index.d.ts`](./src/index.d.ts) and be discussed in an issue first.
- Avoid breaking changes to existing exports. If unavoidable, document them in the PR and add a migration note.

### Tests

- Add or update unit tests for any behavior change.
- Manual smoke test: a minimal page that initializes the SDK, connects, and sends a message should still work.

---

## 📝 Improving Docs

Docs PRs are **highly valued** and have a fast review track:

- README typos / unclear wording
- New code examples in `examples/` *(coming soon)*
- Translations (English is canonical; other languages welcome)

---

## 🚀 Release Process

Maintainers cut releases on a roughly **bi-weekly** cadence:

1. Pick merged PRs for the release milestone.
2. Bump version via `npm run update:version`.
3. Build artifacts: `npm run release`.
4. Tag & publish: `git tag vX.Y.Z && git push --tags` → GitHub Release → `npm publish`.

---

## 🏷️ Issue Labels

| Label            | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `bug`            | Confirmed bug or reproducible error              |
| `enhancement`    | New feature or improvement                       |
| `docs`           | Documentation only                               |
| `good first issue` | Good entry point for new contributors           |
| `help wanted`    | Maintainers would love a PR here                 |
| `question`       | Needs discussion before action                   |
| `priority/high`  | Affects core flows / many users                  |

---

## 🙏 Thank You

Every contribution — a typo fix, a bug report, a feature PR, a tweet — helps JuggleIM grow.
You're awesome. ⭐
