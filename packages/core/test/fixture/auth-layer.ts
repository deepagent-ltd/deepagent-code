import { Layer } from "effect"
import { Auth } from "@deepagent-code/core/auth"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { eventLayer } from "./event-layer"
import { tmpRootShared } from "./tmpdir"

export const authLayer = () =>
  Auth.layer.pipe(
    Layer.provideMerge(eventLayer()),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ config: tmpRootShared() })),
  )
