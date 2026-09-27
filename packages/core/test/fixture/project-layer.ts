import { Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Project } from "@deepagent-code/core/project"

// Project.defaultLayer hides a second Database.defaultLayer. Share the test's explicit
// database so project lookups cannot escape into the developer's authority store.
export const projectLayer = <E, R>(database: Layer.Layer<Database.Service, E, R>) =>
  Project.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Git.defaultLayer),
  )
