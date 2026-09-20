import { Layer } from "effect"

// MemoMaps own Layer instance identity and resource reference counts. Sharing one across
// independently disposable runtime roots couples their services and finalizers, so every
// production/temporary root must request its own map.
export const makeMemoMap = () => Layer.makeMemoMapUnsafe()
