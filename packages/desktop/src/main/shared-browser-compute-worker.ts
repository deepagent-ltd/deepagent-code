import { parentPort, workerData } from "node:worker_threads"
import { createHash } from "node:crypto"
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core"
import variant from "@jitl/quickjs-wasmfile-release-sync"

// This trusted worker only bridges immutable JSON bytes. Guest code has no host
// callbacks, module loader, jobs, browser objects or authority over this worker.
const input = workerData as { source: string; argsJSON: string; pageJSON: string; deadline: number; wasm: Uint8Array }
async function run() {
  if (!parentPort || !input || typeof input.source !== "string" || Buffer.byteLength(input.source) > 8192 ||
    typeof input.argsJSON !== "string" || Buffer.byteLength(input.argsJSON) > 8192 || typeof input.pageJSON !== "string" ||
    Buffer.byteLength(input.pageJSON) > 1_048_576 || !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() ||
    !(input.wasm instanceof Uint8Array) || input.wasm.byteLength !== 503134 ||
    createHash("sha256").update(input.wasm).digest("hex") !== "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232") throw new Error("Invalid computation input")
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 })
  const binary = input.wasm.buffer.slice(input.wasm.byteOffset, input.wasm.byteOffset + input.wasm.byteLength) as ArrayBuffer
  const compiled = await WebAssembly.compile(binary)
  const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, {
    wasmBinary: binary,
    // An explicit module uses Emscripten instantiateWasm; file/fetch acquisition
    // paths are never selected, including initialization on a relocated host.
    wasmModule: compiled,
    wasmMemory: memory,
  }))
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(16 * 1024 * 1024)
  runtime.setMaxStackSize(512 * 1024)
  runtime.removeModuleLoader()
  runtime.setInterruptHandler(() => Date.now() >= input.deadline)
  const context = runtime.newContext()
  try {
    parentPort.postMessage({ type: "started" })
    const result = context.evalCode(expression(), "dac-snapshot-json.js", { type: "global" })
    if (result.error) { result.error.dispose(); throw new Error("Computation rejected") }
    try {
      if (context.typeof(result.value) !== "string") throw new Error("Non-JSON computation result")
      const json = context.getString(result.value)
      if (Buffer.byteLength(json) > 65536) throw new Error("Computation result too large")
      JSON.parse(json)
      parentPort.postMessage({ type: "result", json, memoryBytes: memory.buffer.byteLength })
    } finally { result.value.dispose() }
  } finally { context.dispose(); runtime.dispose() }
}

function expression() {
  return `(() => {
        const parse = JSON.parse.bind(JSON), quote = JSON.stringify.bind(JSON);
        const createFunction = Function, objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
        const prototype = Object.getPrototypeOf.bind(Object), descriptors = Object.getOwnPropertyDescriptors.bind(Object);
        const descriptor = Object.getOwnPropertyDescriptor.bind(Object), keys = Reflect.ownKeys.bind(Reflect);
        const owns = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
        const isArray = Array.isArray.bind(Array), finite = Number.isFinite.bind(Number);
        const Invalid = TypeError;
                const ancestors = new WeakSet(), has = ancestors.has.bind(ancestors), add = ancestors.add.bind(ancestors), remove = ancestors.delete.bind(ancestors);
        const argumentsValue = parse(${JSON.stringify(input.argsJSON)}), page = parse(${JSON.stringify(input.pageJSON)});
        const result = createFunction("args", "page", ${JSON.stringify('"use strict";\n' + input.source)})(argumentsValue, page);
        let nodes = 0, outputBytes = 0;
        const chunk = value => { outputBytes += value.length; if (outputBytes > 65536) throw new Invalid("Script result exceeds its limit"); return value; };
        const serialize = (value, depth) => {
          if (++nodes > 10000 || depth > 32) throw new Invalid("Script result exceeds its limit");
          if (value === null) return chunk("null");
          if (typeof value === "string" || typeof value === "boolean") return chunk(quote(value));
          if (typeof value === "number") { if (!finite(value)) throw new Invalid("Non-JSON script result"); return chunk(quote(value)); }
          if (typeof value !== "object" || has(value)) throw new Invalid("Non-JSON script result");
          const array = isArray(value), parent = prototype(value);
          if (array ? parent !== arrayPrototype : parent !== null && parent !== objectPrototype) throw new Invalid("Non-JSON script result");
          if (descriptor(value, "toJSON") || parent && descriptor(parent, "toJSON")) throw new Invalid("Non-JSON script result");
          const properties = descriptors(value), names = keys(properties);
          add(value);
          let text = chunk(array ? "[" : "{");
          if (array) {
            const length = properties.length?.value;
            if (!finite(length) || length < 0 || length > 10000 || names.length !== length + 1) throw new Invalid("Non-JSON script result");
            for (let index = 0; index < length; index++) {
              const property = properties[index];
              if (!owns(properties, index) || !property || !property.enumerable || !owns(property, "value")) throw new Invalid("Non-JSON script result");
              if (index) text += chunk(",");
              text += serialize(property.value, depth + 1);
            }
          } else {
            for (let index = 0; index < names.length; index++) {
              const name = names[index], property = properties[name];
              if (typeof name !== "string" || !property.enumerable || !owns(property, "value")) throw new Invalid("Non-JSON script result");
              if (index) text += chunk(",");
              text += chunk(quote(name)) + chunk(":") + serialize(property.value, depth + 1);
            }
          }
          remove(value);
          return text + chunk(array ? "]" : "}");
        };
        return serialize(result, 0);
      })()`
}

run().catch(() => parentPort?.postMessage({ type: "error" })).finally(() => parentPort?.close())
