#!/usr/bin/env bun

import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const isolated = await mkdtemp(path.join(tmpdir(), "dac-schema-generate-"))
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "CI"].includes(name),
    ),
  ),
  DEEPAGENT_CODE_TEST_HOME: isolated,
  DEEPAGENT_CODE_HOME: path.join(isolated, "data"),
  DEEPAGENT_CODE_DB: path.join(isolated, "generate.sqlite"),
  DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(isolated, "managed"),
  DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
}

try {
  // Schema generation needs no customer configuration, credentials or database.
  await $`${process.execPath} ./packages/sdk/js/script/build.ts`.cwd(root).env(environment)
  await $`${process.execPath} dev generate > ../sdk/openapi.json`
    .cwd(path.join(root, "packages/deepagent-code"))
    .env(environment)
  // The SDK builder already formats src/gen. Never reformat unrelated sources.
  await $`${process.execPath} prettier --write packages/sdk/openapi.json`.cwd(root).env(environment)
} finally {
  await rm(isolated, { recursive: true, force: true })
}
