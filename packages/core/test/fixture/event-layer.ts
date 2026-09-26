import { Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"

// EventV2.defaultLayer hides Database.defaultLayer and can open the developer's
// durable authority store. Test effects must own an explicit in-memory database.
export const eventLayer = () => EventV2.layer.pipe(Layer.provide(Database.layerFromPath(":memory:")))
