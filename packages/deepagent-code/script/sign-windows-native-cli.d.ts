import { type KeyObject } from "node:crypto";
/** Offline issuer only. The runtime accepts these fixed roles through original
 * inherited handles; this public receipt never creates a Root or Work permit. */
export declare function signWindowsNativeCLI(input: {
    executable: string;
    privateKey: KeyObject;
}): Promise<{
    receiptHash: string;
    imageCount: number;
    signerHash: string;
}>;
