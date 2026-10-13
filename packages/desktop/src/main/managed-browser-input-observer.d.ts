import type { BrowserWindow } from "electron";
export type ManagedBrowserInputAsset = Readonly<{
    schemaVersion: "dac.managed-browser-input.darwin.v1";
    target: "darwin-arm64" | "darwin-x64";
    napiVersion: 8;
    electronVersion: string;
    nodeVersion: string;
    path: string;
    bytes: number;
    sha256: string;
    sourceSha256: string;
}>;
/** Main-only: asset is a publisher manifest selected by the fixed product build. */
export declare function observeManagedBrowserInput(input: {
    window: BrowserWindow;
    invalidate: () => void;
    asset: ManagedBrowserInputAsset;
}): Readonly<{
    status: "available";
    healthy: () => boolean;
    release: () => void;
}> | {
    readonly status: "unavailable";
    readonly reason: "unsupported_runtime";
} | {
    readonly status: "unavailable";
    readonly reason: "window_closed";
} | {
    readonly status: "unavailable";
    readonly reason: "invalid_module";
} | {
    readonly status: "unavailable";
    readonly reason: "observer_unhealthy";
} | {
    readonly status: "unavailable";
    readonly reason: "native_unavailable";
};
export declare function verifyManagedBrowserInputAsset(asset: ManagedBrowserInputAsset): void;
