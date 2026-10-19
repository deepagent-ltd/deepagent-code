export declare const sharedBrowserWasmHash = "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232";
export type SharedBrowserComputationAsset = {
    version: 1;
    workerHash: string;
    workerBytes: number;
    wasmHash: string;
    wasmBytes: number;
    noticeHash: string;
};
/** The trusted build embeds the expected worker digest. Neither a mutable manifest,
 * a package search path nor an external URL supplies executable authority. */
export declare function sharedBrowserComputationAsset(): {
    worker: string;
    code: string;
    wasm: Buffer<ArrayBuffer>;
};
export declare function readSharedBrowserComputationAsset(file: string, maximum: number): Buffer<ArrayBuffer>;
