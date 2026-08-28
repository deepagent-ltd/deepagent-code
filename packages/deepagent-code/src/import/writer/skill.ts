import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
  const firstLine = body.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ""
  const base = firstLine.replace(/^#*\s*/, "")
  const summary = base.slice(0, 90).trim()
  return summary || "Imported skill: " + name
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ")
}
