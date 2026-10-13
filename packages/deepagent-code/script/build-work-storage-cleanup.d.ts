/** Independent asset: never rebuilds or replaces the historical Work helper. */
export declare function buildWorkStorageCleanup(input: {
    os: string;
    arch: string;
    abi?: string;
    destination: string;
}): Promise<{
    path: string;
    bytes: number;
    sha256: string;
}>;
