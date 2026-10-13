export function linuxWorkWriteProfile(input: {
  helper: string
  helperSHA256: string
  uid: number
  project: string
  data: string
}): Readonly<{
  scope: Readonly<{
    domain: "dac.linux-work-write-policy.v1"
    helper: string
    helperSHA256: string
    uid: number
    project: string
    data: string
  }>
  profile: string
  profileText: string
  profileSHA256: string
  nativeAuthority: false
}>
