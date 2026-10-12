import { Schema } from "effect";
export declare const LINUX_NATIVE_DEV_MANIFEST = "linux-native-dev-assets.json";
export declare const LINUX_NATIVE_DEV_DOMAIN = "dac.linux-native-dev-assets.v1";
export declare const LINUX_NATIVE_IMAGE_LIMIT = 268435456;
export declare const LINUX_NATIVE_CLOSURE_LIMIT = 128;
export declare const LINUX_NATIVE_CLOSURE_BYTES = 268435456;
export declare const LINUX_NATIVE_TOTAL_BYTES = 536870912;
declare const targets: readonly ["linux-x64", "linux-arm64"];
export type LinuxNativeTarget = typeof targets[number];
declare const record: Schema.Struct<{
    readonly path: Schema.String;
    readonly bytes: Schema.Int;
    readonly sha256: Schema.String;
}>;
export declare const LinuxNativeDevManifest: Schema.Struct<{
    readonly schemaVersion: Schema.Literal<"dac.linux-native-dev-assets.v1">;
    readonly target: Schema.Literals<readonly ["linux-x64", "linux-arm64"]>;
    readonly sourceCommit: Schema.String;
    readonly sourceTree: Schema.String;
    readonly source: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly bytes: Schema.Int;
        readonly sha256: Schema.String;
    }>>;
    readonly tools: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly bytes: Schema.Int;
        readonly sha256: Schema.String;
        readonly version: Schema.String;
    }>>;
    readonly runtimeVersion: Schema.String;
    readonly assets: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly bytes: Schema.Int;
        readonly sha256: Schema.String;
    }>>;
    readonly licenses: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly bytes: Schema.Int;
        readonly sha256: Schema.String;
    }>>;
}>;
export type LinuxNativeDevManifest = typeof LinuxNativeDevManifest.Type;
export type LinuxNativeAsset = typeof record.Type;
/** One captured toolchain builds all three original bins; dispatcher shims are never invoked as Cargo. */
export declare function linuxNativeCargoInvocation(input: {
    cargo: string;
    rustc: string;
    target: LinuxNativeTarget;
    targetDirectory: string;
    environment?: NodeJS.ProcessEnv;
}): {
    rustTarget: string;
    args: string[];
    env: {
        NODE_ENV?: string | undefined;
        TZ?: string | undefined;
        RUSTC: string;
        CARGO_TARGET_DIR: string;
    };
};
/** Data-only build inventory. It never supplies NativeInstallation authority. */
export declare function inspectLinuxNativeAssets(input: {
    directory: string;
    target: LinuxNativeTarget;
    expectedManifestHash?: string;
}): Promise<{
    manifest: {
        readonly schemaVersion: "dac.linux-native-dev-assets.v1";
        readonly target: "linux-arm64" | "linux-x64";
        readonly sourceCommit: string;
        readonly sourceTree: string;
        readonly source: readonly {
            readonly path: string;
            readonly bytes: number;
            readonly sha256: string;
        }[];
        readonly tools: readonly {
            readonly name: string;
            readonly bytes: number;
            readonly sha256: string;
            readonly version: string;
        }[];
        readonly runtimeVersion: string;
        readonly assets: readonly {
            readonly path: string;
            readonly bytes: number;
            readonly sha256: string;
        }[];
        readonly licenses: readonly {
            readonly path: string;
            readonly bytes: number;
            readonly sha256: string;
        }[];
    };
    manifestHash: string;
    files: string[];
}>;
/** Fixed native Ubuntu/glibc build. No payload, ldd, signing key or remote runtime is invoked. */
export declare function buildLinuxNativeAssets(input: {
    destination: string;
}): Promise<{
    target: "linux-arm64" | "linux-x64";
    manifestPath: string;
    manifestHash: string;
    assets: {
        path: string;
        bytes: number;
        sha256: string;
    }[];
}>;
export {};
