type Scope = {
  helper: string
  helperSHA256: string
  uid: number
  project: string
  data: string
}
export function inspectProjectWriteScope(input: Scope): Promise<Readonly<{
  projectIdentity: { kind: "posix"; device: string; inode: string }
  dataIdentity: { kind: "posix"; device: string; inode: string }
}>>
export function prepareProjectWrite(installation: { prefix: string }, input: Pick<Scope, "uid" | "project" | "data">,
  tools: {
    readOwned: (filename: string, limit: number) => Promise<Buffer>
    command: (filename: string, args: string[]) => Promise<{ code: number | null }>
  }): Promise<{ status: "write_policy_current" | "write_policy_prepared"; profile: string; nativeAuthority: false }>
