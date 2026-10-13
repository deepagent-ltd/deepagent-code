//! Fixed execution mode. The trusted host supplies the already approved descriptor and
//! launches this helper under an OS sandbox; this mode cannot create that authority.
use crate::protocol::Identity;
use serde::Deserialize;
use std::{collections::BTreeMap, io::{self, Read}};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    version: u8,
    workspace: String,
    workspace_identity: Identity,
    executable: String,
    executable_identity: Identity,
    executable_sha256: String,
    executable_bytes: u64,
    argv: Vec<String>,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    cpu_seconds: u64,
}

pub fn exec() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut length = [0; 4]; input.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > crate::protocol::FRAME_LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
    let mut body = vec![0; length]; input.read_exact(&mut body)?;
    let command: Command = serde_json::from_slice(&body).map_err(|_| io::ErrorKind::InvalidData)?;
    drop(input);
    native(command)
}

#[cfg(target_os = "macos")]
fn native(command: Command) -> io::Result<()> {
    use crate::{no_follow, root::Root};
    use sha2::{Digest, Sha256};
    use std::{fs::File, os::unix::{fs::MetadataExt, process::CommandExt}, path::Path, process::Stdio};
    use rustix::fs::{Mode, OFlags, open};
    if command.version != 1 || command.cpu_seconds == 0 || command.cpu_seconds > 600 || command.argv.len() > 64 ||
        command.argv.iter().any(|arg| arg.len() > 2048 || arg.contains('\0')) ||
        command.argv.iter().map(String::len).sum::<usize>() > 16_384 ||
        command.executable_bytes == 0 || command.executable_bytes > 268_435_456 ||
        command.env.len() > 8 || command.env.iter().any(|(name, value)|
            !["CI", "LANG", "LC_ALL", "TZ", "NO_COLOR", "FORCE_COLOR", "SOURCE_DATE_EPOCH"].contains(&name.as_str()) ||
                value.len() > 128 || value.chars().any(char::is_control)) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let workspace = Root::open(&command.workspace, command.workspace_identity)?;
    let stat = workspace.file.metadata()?;
    if stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o077 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    let cwd = match command.cwd {
        None => workspace.path.clone(),
        Some(relative) => { no_follow::relative(&relative)?; workspace.path.join(relative) },
    };
    let directory = no_follow::open_root(&cwd)?;
    let executable = Path::new(&command.executable);
    if !executable.is_absolute() || std::fs::canonicalize(executable)? != executable ||
        command.executable.chars().any(char::is_control) { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut file = File::from(open(executable, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
    let stamp = no_follow::stamp(&file)?;
    let stat = file.metadata()?;
    if !stat.is_file() || stat.nlink() != 1 || stat.mode() & 0o022 != 0 || stat.mode() & 0o111 == 0 ||
        stat.len() != command.executable_bytes || no_follow::identity(&file)? != command.executable_identity {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut hash = Sha256::new();
    let copied = io::copy(&mut file.by_ref().take(command.executable_bytes + 1), &mut hash)?;
    if copied != command.executable_bytes || format!("{:x}", hash.finalize()) != command.executable_sha256 ||
        no_follow::stamp(&file)? != stamp || no_follow::stamp(&File::open(executable)?)? != stamp {
        return Err(io::ErrorKind::InvalidData.into());
    }
    workspace.current()?;
    if no_follow::identity(&directory)? != no_follow::identity(&no_follow::open_root(&cwd)?)? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    for (resource, value) in [(libc::RLIMIT_FSIZE, 1_048_576), (libc::RLIMIT_NOFILE, 64), (libc::RLIMIT_CPU, command.cpu_seconds)] {
        let limit = libc::rlimit { rlim_cur: value, rlim_max: value };
        if unsafe { libc::setrlimit(resource, &limit) } != 0 { return Err(io::Error::last_os_error()); }
    }
    drop(file); drop(directory); drop(workspace.file);
    // CLOEXEC on all native descriptors, null stdin, exact executable and argv. The
    // host's deadline owns this same process through exec; no supervisor child is forked.
    Err(std::process::Command::new(executable).args(command.argv).current_dir(cwd).env_clear()
        .envs(command.env).env("HOME", workspace.path.join(".dac-home")).env("TMPDIR", workspace.path.join(".dac-tmp"))
        .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0").stdin(Stdio::null()).exec())
}

#[cfg(not(target_os = "macos"))]
fn native(_: Command) -> io::Result<()> { Err(io::ErrorKind::Unsupported.into()) }
