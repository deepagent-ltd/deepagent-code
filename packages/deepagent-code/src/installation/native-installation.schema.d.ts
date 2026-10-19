import { Schema } from "effect";
export declare const DOMAIN = "dac.native-installation.v1";
export declare const NODE_DOMAIN = "dac.native-node-installation.v1";
export declare const SIDECAR_SUFFIX = ".native-installation.json";
export declare const MANIFEST_LIMIT = 16384;
export declare const COMPONENTS_LIMIT = 1048576;
export declare const EXECUTABLE_LIMIT = 1073741824;
declare const Component_base: Schema.Class<Component, Schema.Struct<{
    readonly path: Schema.String;
    readonly bytes: Schema.Number;
    readonly sha256: Schema.String;
}>, {}>;
export declare class Component extends Component_base {
}
declare const Components_base: Schema.Class<Components, Schema.Struct<{
    readonly schemaVersion: Schema.Literal<"dac.native-components.v1">;
    readonly target: Schema.String;
    readonly sourceCommit: Schema.String;
    readonly sourceTree: Schema.String;
    readonly components: Schema.$Array<typeof Component>;
}>, {}>;
/** The release signer attests this build input inventory; runtime does not recover source from machine code. */
export declare class Components extends Components_base {
}
declare const Executable_base: Schema.Class<Executable, Schema.Struct<{
    readonly bytes: Schema.Number;
    readonly sha256: Schema.String;
}>, {}>;
export declare class Executable extends Executable_base {
}
declare const Payload_base: Schema.Class<Payload, Schema.Struct<{
    readonly domain: Schema.Literal<"dac.native-installation.v1">;
    readonly releaseID: Schema.String;
    readonly target: Schema.String;
    readonly sourceCommit: Schema.String;
    readonly sourceTree: Schema.String;
    readonly componentsHash: Schema.String;
    readonly executable: typeof Executable;
}>, {}>;
export declare class Payload extends Payload_base {
}
declare const Manifest_base: Schema.Class<Manifest, Schema.Struct<{
    readonly payload: typeof Payload;
    readonly signature: Schema.String;
}>, {}>;
export declare class Manifest extends Manifest_base {
}
declare const NodePayload_base: Schema.Class<NodePayload, Schema.Struct<{
    readonly domain: Schema.Literal<"dac.native-node-installation.v1">;
    readonly releaseID: Schema.String;
    readonly target: Schema.String;
    readonly sourceCommit: Schema.String;
    readonly sourceTree: Schema.String;
    readonly componentsHash: Schema.String;
    readonly executable: typeof Executable;
    readonly runtime: typeof Executable;
}>, {}>;
export declare class NodePayload extends NodePayload_base {
}
declare const NodeManifest_base: Schema.Class<NodeManifest, Schema.Struct<{
    readonly payload: typeof NodePayload;
    readonly signature: Schema.String;
}>, {}>;
export declare class NodeManifest extends NodeManifest_base {
}
export declare const WINDOWS_OBSERVATION_LIMIT = 131328;
declare const WindowsFile: Schema.Struct<{
    readonly identity: Schema.String;
    readonly hash: Schema.String;
    readonly bytes: Schema.Int;
    readonly text: Schema.NullOr<Schema.String>;
}>;
export declare const WindowsObservation: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly artifact: Schema.Struct<{
        readonly identity: Schema.String;
        readonly hash: Schema.String;
        readonly bytes: Schema.Int;
        readonly text: Schema.NullOr<Schema.String>;
    }>;
    readonly manifest: Schema.Struct<{
        readonly identity: Schema.String;
        readonly hash: Schema.String;
        readonly bytes: Schema.Int;
        readonly text: Schema.NullOr<Schema.String>;
    }>;
    readonly runtime: Schema.Struct<{
        readonly identity: Schema.String;
        readonly hash: Schema.String;
        readonly bytes: Schema.Int;
        readonly text: Schema.NullOr<Schema.String>;
    }>;
    readonly bootstrap_sha256: Schema.String;
}>;
type WindowsFile = typeof WindowsFile.Type;
type WindowsFiles = Readonly<{
    version: number;
    artifact: WindowsFile;
    manifest: WindowsFile;
    runtime: WindowsFile;
    bootstrap_sha256: string;
}>;
/** Exact public-data equality only; this never grants current or installation authority. */
export declare function sameWindowsFiles(left: WindowsFiles, right: WindowsFiles, expectedBootstrapHash?: string): boolean;
export declare const ErrorCode: Schema.Literals<readonly ["NATIVE_INSTALLATION_UNAVAILABLE", "NATIVE_MANIFEST_INVALID", "NATIVE_SIGNATURE_INVALID", "NATIVE_COMPONENTS_MISMATCH", "NATIVE_TARGET_MISMATCH", "NATIVE_BYTES_MISMATCH", "NATIVE_IDENTITY_CHANGED", "NATIVE_HANDLE_INVALID"]>;
declare const Error_base: Schema.Class<Error, Schema.TaggedStruct<"NativeInstallationError", {
    readonly code: Schema.Literals<readonly ["NATIVE_INSTALLATION_UNAVAILABLE", "NATIVE_MANIFEST_INVALID", "NATIVE_SIGNATURE_INVALID", "NATIVE_COMPONENTS_MISMATCH", "NATIVE_TARGET_MISMATCH", "NATIVE_BYTES_MISMATCH", "NATIVE_IDENTITY_CHANGED", "NATIVE_HANDLE_INVALID"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/** No filesystem, parser, crypto or request cause is retained in this public error. */
export declare class Error extends Error_base {
}
export * as NativeInstallationSchema from "./native-installation.schema";
