import { type KeyObject } from "node:crypto";
/** This is the existing internal publisher pin. It is unrelated to Windows
 * application signing, SAC, or a user installation license. */
export declare function windowsNativePublisherPin(publicKey: string | KeyObject): string;
/** Target-platform build only. Root owns publication of the returned artifact;
 * this operation never registers a native port or grants runtime authority. */
export declare function buildWindowsNativeBootstrap(input: {
    repository: string;
    staging: string;
    publicKey: string | KeyObject;
}): Promise<Readonly<{
    assets: readonly Readonly<{
        path: `packages/work-file-helper/bin/win32-arm/${string}` | `packages/work-file-helper/bin/win32-arm64/${string}` | `packages/work-file-helper/bin/win32-ia32/${string}` | `packages/work-file-helper/bin/win32-loong64/${string}` | `packages/work-file-helper/bin/win32-mips/${string}` | `packages/work-file-helper/bin/win32-mipsel/${string}` | `packages/work-file-helper/bin/win32-ppc64/${string}` | `packages/work-file-helper/bin/win32-riscv64/${string}` | `packages/work-file-helper/bin/win32-s390x/${string}` | `packages/work-file-helper/bin/win32-x64/${string}`;
        bytes: number;
        sha256: string;
    }>[];
    licenses: readonly Readonly<{
        path: `packages/work-file-helper/bin/win32-arm/${string}` | `packages/work-file-helper/bin/win32-arm64/${string}` | `packages/work-file-helper/bin/win32-ia32/${string}` | `packages/work-file-helper/bin/win32-loong64/${string}` | `packages/work-file-helper/bin/win32-mips/${string}` | `packages/work-file-helper/bin/win32-mipsel/${string}` | `packages/work-file-helper/bin/win32-ppc64/${string}` | `packages/work-file-helper/bin/win32-riscv64/${string}` | `packages/work-file-helper/bin/win32-s390x/${string}` | `packages/work-file-helper/bin/win32-x64/${string}`;
        bytes: number;
        sha256: string;
    }>[];
    filename: string;
    path: "packages/work-file-helper/bin/win32-arm/native-image-factory.node" | "packages/work-file-helper/bin/win32-arm64/native-image-factory.node" | "packages/work-file-helper/bin/win32-ia32/native-image-factory.node" | "packages/work-file-helper/bin/win32-loong64/native-image-factory.node" | "packages/work-file-helper/bin/win32-mips/native-image-factory.node" | "packages/work-file-helper/bin/win32-mipsel/native-image-factory.node" | "packages/work-file-helper/bin/win32-ppc64/native-image-factory.node" | "packages/work-file-helper/bin/win32-riscv64/native-image-factory.node" | "packages/work-file-helper/bin/win32-s390x/native-image-factory.node" | "packages/work-file-helper/bin/win32-x64/native-image-factory.node";
    bytes: number;
    sha256: string;
    publisherPin: string;
}>>;
/** Runs after final sidecar and sealed Node bytes exist. Names/placement are
 * compiler constants; no caller-chosen image or command path enters the ticket. */
export declare function signWindowsNativeSidecar(input: {
    mainDirectory: string;
    privateKey: KeyObject;
    bootstrapHash: string;
    publisherPin: string;
}): Promise<Readonly<{
    sha256: string;
    images: {
        bytes: number;
        name: "native-image-factory.node" | "node.js" | "sidecar.js";
        sha256: string;
    }[];
    publisherPin: string;
}>>;
