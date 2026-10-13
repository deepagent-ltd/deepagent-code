/** Build one fixed reviewed helper. No runtime environment variable selects an executable. */
export declare function buildWorkFileHelper(input: {
    os: string;
    arch: string;
    abi?: string;
    destination: string;
}): Promise<{
    path: string;
    bytes: number;
    sha256: string;
}>;
