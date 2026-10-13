//! A bounded copy of explicitly approved streams into a host-owned private workspace.
//! Source metadata detects changes; the manifest describes copied bytes, not an atomic
//! snapshot of all project files. The command never receives a live project descriptor.
use crate::{protocol::Identity, root::Root};
use serde::{Deserialize, Serialize};
use std::io;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub relative: String,
    pub identity: Identity,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub workspace: Identity,
    pub manifest_sha256: String,
    pub files: usize,
    pub bytes: u64,
    pub output_files: usize,
}

#[cfg(unix)]
pub fn prepare(root: &Root, workspace: &str, expected: &Identity, inputs: &[Input], outputs: &[String], deadline_ms: u64) -> io::Result<Snapshot> {
    use crate::no_follow;
    use rustix::fs::{Mode, OFlags, mkdirat, openat};
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeSet, fs::File, io::{Read, Write}, os::unix::fs::MetadataExt, time::{Duration, Instant}};

    if inputs.is_empty() || inputs.len() > 256 || outputs.len() > 32 || deadline_ms == 0 || deadline_ms > 30_000 ||
        inputs.iter().map(|input| input.relative.len()).sum::<usize>() + outputs.iter().map(String::len).sum::<usize>() > 8192 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    root.current()?;
    let target = Root::open(workspace, expected.clone())?;
    let stat = target.file.metadata()?;
    if !stat.is_dir() || stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o077 != 0 ||
        target.path.starts_with(&root.path) || root.path.starts_with(&target.path) ||
        std::fs::read_dir(&target.path)?.next().is_some() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut names = BTreeSet::new();
    for name in inputs.iter().map(|input| input.relative.as_str()).chain(outputs.iter().map(String::as_str)) {
        let parts = no_follow::relative(name)?;
        if parts.len() > 16 || !names.insert(name) || parts[0] == ".dac-home" || parts[0] == ".dac-tmp" {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    // Reject file/directory aliasing before creating any destination object.
    for name in &names {
        let mut parents = name.rsplit('/'); parents.next();
        let mut prefix = *name;
        for _ in parents {
            prefix = prefix.rsplit_once('/').ok_or(io::ErrorKind::InvalidInput)?.0;
            if names.contains(prefix) { return Err(io::ErrorKind::InvalidInput.into()); }
        }
    }
    let limit = inputs.iter().try_fold(0u64, |sum, input| {
        if input.bytes > 16_777_216 || input.sha256.len() != 64 || !input.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        sum.checked_add(input.bytes).filter(|sum| *sum <= 67_108_864).ok_or(io::ErrorKind::InvalidInput.into())
    })?;
    let parent = |relative: &str| -> io::Result<File> {
        let parts = no_follow::relative(relative)?;
        let mut directory = target.file.try_clone()?;
        for part in &parts[..parts.len()-1] {
            match mkdirat(&directory, *part, Mode::from_raw_mode(0o700)) {
                Ok(()) => {},
                Err(error) if error == rustix::io::Errno::EXIST => {},
                Err(error) => return Err(error.into()),
            }
            directory = File::from(openat(&directory, *part, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
            let stat = directory.metadata()?;
            if stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o077 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        }
        Ok(directory)
    };
    let mut manifest = Sha256::new();
    manifest.update(b"dac-work-command-inputs.v1\0");
    let mut copied = 0u64;
    for input in inputs {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        root.current()?; target.current()?;
        let parts = no_follow::relative(&input.relative)?;
        let mut source = no_follow::open_relative(&root.file, &parts)?;
        let before = no_follow::stamp(&source)?;
        if no_follow::identity(&source)? != input.identity || source.metadata()?.len() != input.bytes {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut destination = File::from(openat(parent(&input.relative)?, *parts.last().ok_or(io::ErrorKind::InvalidInput)?,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::from_raw_mode(0o600))?);
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0; 65_536];
        loop {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            let count = source.read(&mut buffer)?;
            if count == 0 { break; }
            bytes = bytes.checked_add(count as u64).ok_or(io::ErrorKind::InvalidData)?;
            copied = copied.checked_add(count as u64).ok_or(io::ErrorKind::InvalidData)?;
            if bytes > input.bytes || copied > limit { return Err(io::ErrorKind::InvalidData.into()); }
            hash.update(&buffer[..count]); destination.write_all(&buffer[..count])?;
        }
        destination.sync_all()?;
        if bytes != input.bytes || format!("{:x}", hash.finalize()) != input.sha256 ||
            no_follow::stamp(&source)? != before || no_follow::stamp(&no_follow::open_relative(&root.file, &parts)?)? != before {
            return Err(io::ErrorKind::InvalidData.into());
        }
        drop(destination);
        let encoded = serde_json::to_vec(input)?;
        manifest.update((encoded.len() as u64).to_be_bytes()); manifest.update(encoded);
    }
    for output in outputs {
        let parts = no_follow::relative(output)?;
        let file = File::from(openat(parent(output)?, *parts.last().ok_or(io::ErrorKind::InvalidInput)?,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::from_raw_mode(0o600))?);
        file.sync_all()?;
    }
    for directory in [".dac-home", ".dac-tmp"] { mkdirat(&target.file, directory, Mode::from_raw_mode(0o700))?; }
    target.current()?; root.current()?;
    if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
    Ok(Snapshot { workspace: target.identity, manifest_sha256: format!("{:x}", manifest.finalize()), files: inputs.len(), bytes: copied, output_files: outputs.len() })
}

#[cfg(windows)]
pub fn prepare(root: &Root, workspace: &str, expected: &Identity, inputs: &[Input], outputs: &[String], deadline_ms: u64) -> io::Result<Snapshot> {
    crate::snapshot_windows::prepare(root, workspace, expected, inputs, outputs, deadline_ms)
}

#[cfg(not(any(unix, windows)))]
pub fn prepare(_: &Root, _: &str, _: &Identity, _: &[Input], _: &[String], _: u64) -> io::Result<Snapshot> {
    Err(io::ErrorKind::Unsupported.into())
}
