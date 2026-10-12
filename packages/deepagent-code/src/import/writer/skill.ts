import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { isExcludedFile } from "../util/secrets"
import type { SkillItem } from "../ir"
import type { SkillImportResult } from "../types"

export function writeSkills(skills: SkillItem[], configDir: string): SkillImportResult {
  const skillsDir = join(configDir, "skills")
  mkdirSync(skillsDir, { recursive: true })
  let written = 0
  let skipped = 0
  for (const skill of skills) {
    if (!skill.name) {
      skipped += 1
      continue
    }
    const dir = join(skillsDir, skill.name)
    mkdirSync(dir, { recursive: true })
    if (skill.sourceDir && existsSync(skill.sourceDir)) {
      for (const name of readdirSync(skill.sourceDir)) {
        if (name === "SKILL.md" || isExcludedFile(name)) continue
        try {
          const src = join(skill.sourceDir, name)
          writeFileSync(join(dir, name), readFileSync(src))
        } catch {
          /* best-effort asset copy */
        }
      }
    }
    const body = ensureFrontmatter(skill)
    writeFileSync(join(dir, "SKILL.md"), body, "utf8")
    written += 1
  }
  return { written, skipped }
}

export async function writeSkillControlled(
  skill: SkillItem,
  configDir: string,
  checkpoint: () => Promise<void>,
  verifySource: (filename: string, bytes: Buffer) => void,
) {
  if (
    !skill.name ||
    skill.name === "." ||
    skill.name === ".." ||
    /[\\/:\u0000-\u001f\u007f]/.test(skill.name) ||
    Buffer.byteLength(skill.name) > 255
  )
    throw new Error("IMPORT_SKILL_NAME_INVALID: skill requires one safe directory name")
  const destination = path.join(configDir, "skills", skill.name)
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  const copy = async (relative: string): Promise<void> => {
    await checkpoint()
    if (!skill.sourceDir) return
    const filename = path.join(skill.sourceDir, relative)
    const stat = await fs.lstat(filename)
    if (stat.isSymbolicLink() || (await fs.realpath(filename)) !== filename)
      throw new Error("IMPORT_SKILL_SOURCE_CHANGED: asset path changed")
    if (stat.isDirectory()) {
      await fs.mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 })
      for await (const entry of await fs.opendir(filename)) {
        const name = relative ? `${relative}/${entry.name}` : entry.name
        if (name === "SKILL.md" || isExcludedFile(name)) continue
        await copy(name)
      }
      return
    }
    if (!stat.isFile() || stat.size > 16_777_216)
      throw new Error("IMPORT_SKILL_ASSET_INVALID: asset exceeds the regular file budget")
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await file.stat()
      const bytes = Buffer.alloc(stat.size)
      const read = await file.read(bytes, 0, bytes.length, 0)
      const after = await file.stat()
      const named = await fs.lstat(filename)
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size !== bytes.length ||
        read.bytesRead !== bytes.length ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        throw new Error("IMPORT_SKILL_SOURCE_CHANGED: asset changed while reading")
      verifySource(filename, bytes)
      await checkpoint()
      await fs.writeFile(path.join(destination, relative), bytes, { flag: "wx", mode: 0o600 })
    } finally {
      await file.close()
    }
  }
  if (skill.sourceDir) await copy("")
  await checkpoint()
  await fs.writeFile(path.join(destination, "SKILL.md"), ensureFrontmatter(skill), { flag: "wx", mode: 0o600 })
  return { written: 1, skipped: 0 }
}

function ensureFrontmatter(skill: SkillItem): string {
  const description = skill.description || synthDescription(skill.body, skill.name)
  const hasFront = /^---\r?\n[\s\S]*?\r?\n---/.test(skill.body)
  if (hasFront) {
    return skill.body.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_m, front: string) => {
      let f = front
      if (!/^name:/m.test(f)) f = "name: " + skill.name + "\n" + f
      if (!/^description:/m.test(f)) f = f + 'description: "' + escape(description) + '"\n'
      return "---\n" + f + "---"
    })
  }
  return "---\nname: " + skill.name + '\ndescription: "' + escape(description) + '"\n\n' + skill.body.trimStart()
}

function synthDescription(body: string, name: string): string {
  const firstLine =
    body
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  const base = firstLine.replace(/^#*\s*/, "")
  const summary = base.slice(0, 90).trim()
  return summary || "Imported skill: " + name
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ")
}
