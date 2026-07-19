// Ambient declarations for asset modules referenced transitively through the
// deepagent-code source graph (cli imports `deepagent-code/server/server`,
// which pulls in handlers that import image/audio assets). These mirror the
// declarations in packages/deepagent-code/src/audio.d.ts.
declare module "*.wasm" {
  const file: string
  export default file
}
