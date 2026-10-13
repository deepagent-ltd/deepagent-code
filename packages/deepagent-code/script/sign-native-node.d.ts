import { type KeyObject } from "node:crypto";
import { NativeInstallationSchema } from "../src/installation/native-installation.schema";
/** Publisher-only operation, never called by the runtime. Both fixed artifacts are
 * read through a stable descriptor before signing; no private key enters metadata. */
export declare function signNativeNodeArtifact(input: {
    module: string;
    runtime: string;
    releaseID: string;
    privateKey: KeyObject;
}): Promise<{
    payload: NativeInstallationSchema.NodePayload;
    signerHash: string;
}>;
/** Compiled binaries keep the original executable-only Payload domain. The
 * Windows issuer reads its fixed PE through Native, never through mode bits. */
export declare function signNativeCliArtifact(input: {
    executable: string;
    releaseID: string;
    privateKey: KeyObject;
}): Promise<{
    payload: NativeInstallationSchema.Payload;
    signerHash: string;
}>;
