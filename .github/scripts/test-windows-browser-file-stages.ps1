$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Windows browser file stages require an actual Windows Rust host'
}

$nativeStageManifest = Join-Path $PSScriptRoot '../../packages/work-file-helper/Cargo.toml'
& cargo test --locked --manifest-path $nativeStageManifest --bin deepagent-work-file-helper browser_windows::tests -- --format=pretty --color=never |
  Tee-Object -Variable nativeStageOutput
$nativeStageExit = $LASTEXITCODE
if ($nativeStageExit -ne 0) { exit $nativeStageExit }

# Cargo also exits successfully when a filter selects no tests. Require both
# real binary-stage cases; the original six library tests run in package-desktop.
foreach ($nativeStageName in @(
  'browser_windows::tests::original_binary_stage_seals_and_keeps_windows_locks_through_read_and_cleanup',
  'browser_windows::tests::original_binary_stage_publishes_missing_only_and_retains_existing_destination'
)) {
  if (($nativeStageOutput -join "`n") -notmatch ('(?m)^test ' + [regex]::Escape($nativeStageName) + ' \.\.\. ok\r?$')) {
    throw "Windows browser file stage did not pass: $nativeStageName"
  }
}
