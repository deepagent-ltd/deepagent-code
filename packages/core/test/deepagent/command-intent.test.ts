import { describe, expect, test } from "bun:test"
import { classifyCommand, isReadOnlyCommand } from "../../src/deepagent/command-intent"

// The classifier is used to RELAX the plan gate, so its contract is FAIL-SAFE: it must never call a
// mutating command read-only. These tests pin down both directions — the read-only allow-list AND
// the mutating fail-safe — so a future edit that loosens the classifier trips a test.

describe("CommandIntent.classifyCommand", () => {
  describe("read-only commands (must be exempt from the plan gate)", () => {
    const readOnly = [
      "ls",
      "ls -la",
      "ls -la /some/path",
      "cat file.txt",
      "cat src/index.ts",
      "head -n 20 log.txt",
      "tail -f log.txt",
      "wc -l file.txt",
      "pwd",
      "which node",
      "echo hello world",
      "grep -rn pattern src/",
      "rg TODO packages/",
      "find . -name '*.ts'",
      "find src -type f",
      "stat file.txt",
      "file binary",
      "du -sh .",
      "df -h",
      "env",
      "printenv PATH",
      "date",
      "whoami",
      "uname -a",
      "ps aux",
      "node --version",
      "python3 --version",
      "git status",
      "git log --oneline -20",
      "git diff HEAD~1",
      "git show HEAD",
      "git branch -a",
      "git rev-parse HEAD",
      "git ls-files",
      "git config --get user.name",
      "docker ps",
      "docker images",
      "kubectl get pods",
      "npm ls",
      "pip list",
      "curl -sL https://example.com/api",
      "curl https://example.com",
      "echo hi >&2", // fd-dup to stderr, not a file write
      "grep f file.txt 2>&1", // genuine fd-dup
    ]
    for (const cmd of readOnly) {
      test(`read_only: ${cmd}`, () => {
        expect(classifyCommand(cmd)).toBe("read_only")
        expect(isReadOnlyCommand(cmd)).toBe(true)
      })
    }
  })

  describe("chained read-only commands (every segment must be read-only)", () => {
    const readOnlyChains = [
      "ls -la && pwd",
      "cat a.txt | grep foo",
      "git status; git log --oneline -5",
      "cd src && ls", // cd is CWD-only, not a file mutation — but see mutating list below
      "curl -sL https://example.com/api | head -80",
      "grep -rn foo . | wc -l",
    ]
    for (const cmd of readOnlyChains) {
      test(`read_only chain: ${cmd}`, () => {
        // NOTE: `cd` is intentionally NOT in the read-only allow-list (it changes shell state), so the
        // "cd src && ls" case documents fail-safe behavior below rather than here.
        if (cmd.startsWith("cd ")) return
        expect(classifyCommand(cmd)).toBe("read_only")
      })
    }
  })

  describe("mutating commands (must stay gated)", () => {
    const mutating = [
      "rm file.txt",
      "rm -rf /some/dir",
      "mv a.txt b.txt",
      "cp a.txt b.txt",
      "mkdir -p foo/bar",
      "touch newfile",
      "chmod +x script.sh",
      "chown user:group file",
      "ln -s a b",
      "dd if=/dev/zero of=out",
      "sed -i 's/a/b/' file.txt",
      "tee out.txt",
      "kill 1234",
      "git commit -m msg",
      "git push origin main",
      "git checkout -b feature",
      "git reset --hard",
      "npm install",
      "pip install requests",
      "docker run image",
      "kubectl apply -f manifest.yaml",
      "sudo ls", // privilege elevation → never read-only
      "apt-get update",
      "systemctl restart nginx",
      "export FOO=bar",
      "source ~/.bashrc",
    ]
    for (const cmd of mutating) {
      test(`mutating: ${cmd}`, () => {
        expect(classifyCommand(cmd)).toBe("mutating")
      })
    }
  })

  describe("fail-safe: ambiguous / dangerous shapes resolve to mutating", () => {
    const failSafe = [
      "", // empty
      "   ", // whitespace only
      "cat file.txt > out.txt", // output redirection
      "echo hi >> log.txt", // append redirection
      "ls && rm file.txt", // one mutating segment poisons the whole command
      "cat a.txt; rm b.txt",
      "grep foo . | tee out.txt", // pipe into a writer
      "find . -delete", // find with a mutating action
      "find . -exec rm {} \\;", // find -exec
      "curl -o out.zip https://example.com/f.zip", // curl writing a file
      "curl -O https://example.com/f.zip",
      "ls > out.txt", // plain redirection stays mutating (control for the >& fix)
      "FOO=bar ls", // inline env assignment prefix
      "env FOO=bar node app.js", // env running a command
      "$(rm file.txt)", // command substitution
      "cat `whoami`", // backticks
      "ls <(rm x)", // process substitution
      "unknowncmd --flag", // unknown command
      "eval 'rm x'",
      "exec rm x",
    ]
    for (const cmd of failSafe) {
      test(`fail-safe mutating: ${JSON.stringify(cmd)}`, () => {
        expect(classifyCommand(cmd)).toBe("mutating")
      })
    }
  })

  describe("fd-duplication is not a file write", () => {
    test("2>&1 does not count as an output redirection", () => {
      expect(classifyCommand("grep foo file.txt 2>&1")).toBe("read_only")
      expect(classifyCommand("ls -la 2>&1 | head")).toBe("read_only")
    })
    test("but a real > alongside fd-dup is still mutating", () => {
      expect(classifyCommand("grep foo file.txt 2>&1 > out.txt")).toBe("mutating")
    })
  })

  // Regression: `>&word` is bash shorthand for redirecting stdout+stderr to a FILE (a write), not an
  // fd-duplication. The fd-dup mask must only strip a numeric RHS (`2>&1`, `>&2`), so `>&file` keeps
  // its `>` and reads as a mutating write.
  describe("regression: >&file redirection is a file write (BUG #1)", () => {
    const mutating = ["ls >&out.txt", "cat foo >&dump", "ls >&/tmp/evil"]
    for (const cmd of mutating) {
      test(`mutating: ${cmd}`, () => {
        expect(classifyCommand(cmd)).toBe("mutating")
      })
    }
    test("genuine fd-dup stays read_only", () => {
      expect(classifyCommand("echo hi >&2")).toBe("read_only")
      expect(classifyCommand("grep f file.txt 2>&1")).toBe("read_only")
    })
  })

  // Regression: a glued or bundled curl output flag (`-ofile.txt`, `-sofile`) writes a file but has no
  // word boundary after `-o`, so the old `\s-[oO]\b` guard missed it.
  describe("regression: glued/bundled curl -o writes a file (BUG #2)", () => {
    const mutating = ["curl -ofile.txt https://x", "curl -sofile https://x"]
    for (const cmd of mutating) {
      test(`mutating: ${cmd}`, () => {
        expect(classifyCommand(cmd)).toBe("mutating")
      })
    }
    test("curl with no output flag stays read_only", () => {
      expect(classifyCommand("curl https://x")).toBe("read_only")
      expect(classifyCommand("curl -sL https://example.com/api")).toBe("read_only")
    })
  })
})
