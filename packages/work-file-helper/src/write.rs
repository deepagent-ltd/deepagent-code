//! Publication never writes an already published project file descriptor. Payloads are
//! completed in the host's private same-volume stage, then moved by one namespace syscall.
//! This is optimistic publication, not a filesystem compare-and-swap or content snapshot.
use crate::{protocol::{Identity, WriteExpected, WriteObservation}, root::Root};
use std::io;

pub enum Failure { BeforePublish, Unknown }

#[cfg(any(target_vendor = "apple", target_os = "linux"))]
mod native {
    use super::*;
    use crate::{no_follow, protocol::{PAGE_LIMIT, SCAN_LIMIT}};
    use rustix::fs::{AtFlags, Mode, OFlags, RenameFlags, openat, renameat_with, unlinkat};
    use sha2::{Digest, Sha256};
    use std::{fs::File, io::{Read, Write}, os::unix::fs::MetadataExt,
        path::PathBuf, time::{Duration, Instant}};

    pub struct Prepared {
        id: String,
        relative: String,
        parent: File,
        parent_identity: Identity,
        stage: Root,
        expected: WriteExpected,
        payload_identity: Identity,
        hash: String,
        bytes: u64,
        deadline: Instant,
        limit: u64,
    }

    impl Prepared {
        pub fn prepare(root: &Root, id: &str, relative: &str, stage: &str, stage_identity: &Identity,
            content: &str, expected: &WriteExpected, deadline_ms: u64) -> io::Result<Self> {
            if content.len() as u64 > PAGE_LIMIT || deadline_ms == 0 || deadline_ms > 30_000 {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            if let WriteExpected::Observed { sha256, bytes, .. } = expected {
                if *bytes > SCAN_LIMIT || sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
            }
            root.current()?;
            let path = PathBuf::from(stage);
            if path.starts_with(&root.path) || root.path.starts_with(&path) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let stage = Root::open(stage, stage_identity.clone())?;
            current_stage(&stage, root)?;
            let parts = no_follow::relative(relative)?;
            let parent = parent(root, &parts)?;
            let parent_identity = no_follow::identity(&parent)?;
            let deadline = Instant::now() + Duration::from_millis(deadline_ms);
            check_expected(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, expected, deadline)?;
            let mut payload = File::from(openat(&stage.file, "payload",
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600))?);
            payload.write_all(content.as_bytes())?;
            payload.sync_all()?;
            let payload_identity = no_follow::identity(&payload)?;
            // No writable project descriptor survives publication. The stage may preserve
            // an object after failure, so this function never guesses that cleanup is safe.
            drop(payload);
            current_stage(&stage, root)?;
            root.current()?;
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            Ok(Self { id: id.to_owned(), relative: relative.to_owned(), parent, parent_identity,
                stage, expected: expected.clone(), payload_identity,
                hash: format!("{:x}", Sha256::digest(content.as_bytes())), bytes: content.len() as u64, deadline, limit: SCAN_LIMIT })
        }

        pub fn prepare_binary(root: &Root, id: &str, relative: &str, stage: &str, stage_identity: &Identity,
            bytes: u64, hash: &str, deadline_ms: u64) -> io::Result<Self> {
            if bytes > crate::binary::LIMIT || hash.len() != 64 ||
                !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) ||
                deadline_ms == 0 || deadline_ms > 30_000 {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            root.current()?;
            let path = PathBuf::from(stage);
            if path.starts_with(&root.path) || root.path.starts_with(&path) { return Err(io::ErrorKind::PermissionDenied.into()); }
            let stage = Root::open(stage, stage_identity.clone())?;
            current_stage(&stage, root)?;
            let parts = no_follow::relative(relative)?;
            let parent = parent(root, &parts)?;
            let parent_identity = no_follow::identity(&parent)?;
            let deadline = Instant::now() + Duration::from_millis(deadline_ms);
            check_expected(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, &WriteExpected::Missing, deadline)?;
            let payload = regular(&stage.file, "payload")?;
            let payload_identity = no_follow::identity(&payload)?;
            if observe(payload, deadline, crate::binary::LIMIT)? != (hash.to_owned(), bytes) {
                return Err(io::ErrorKind::InvalidData.into());
            }
            current_stage(&stage, root)?;
            root.current()?;
            Ok(Self { id: id.to_owned(), relative: relative.to_owned(), parent, parent_identity, stage,
                expected: WriteExpected::Missing, payload_identity, hash: hash.to_owned(), bytes,
                deadline, limit: crate::binary::LIMIT })
        }

        pub fn id(&self) -> &str { &self.id }

        pub fn description(&self) -> crate::protocol::WritePreparation {
            crate::protocol::WritePreparation { parent: self.parent_identity.clone(), stage: self.stage.identity.clone() }
        }

        pub fn publish(self, root: &Root) -> Result<WriteObservation, Failure> {
            let parts = no_follow::relative(&self.relative).map_err(|_| Failure::BeforePublish)?;
            let leaf = parts.last().ok_or(Failure::BeforePublish)?;
            let before = || -> io::Result<()> {
                root.current()?;
                current_stage(&self.stage, root)?;
                if no_follow::identity(&parent(root, &parts)?)? != self.parent_identity || Instant::now() >= self.deadline {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                check_expected(&self.parent, leaf, &self.expected, self.deadline)?;
                let payload = regular(&self.stage.file, "payload")?;
                if no_follow::identity(&payload)? != self.payload_identity ||
                    observe(payload, self.deadline, self.limit)? != (self.hash.clone(), self.bytes) {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                Ok(())
            };
            before().map_err(|_| Failure::BeforePublish)?;
            let flags = match self.expected { WriteExpected::Missing => RenameFlags::NOREPLACE, _ => RenameFlags::EXCHANGE };
            // The OS sandbox must authorize this *current* namespace operation. An open
            // parent FD alone would allow publishing after an external move out of scope.
            // Any error at this boundary stays unknown; there is no replace/rename fallback.
            renameat_with(&self.stage.file, "payload", &self.parent, *leaf, flags).map_err(|_| Failure::Unknown)?;
            let after = || -> io::Result<WriteObservation> {
                root.current()?;
                current_stage(&self.stage, root)?;
                if no_follow::identity(&parent(root, &parts)?)? != self.parent_identity {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                sync_directory(&self.parent)?;
                sync_directory(&self.stage.file)?;
                let published = regular(&self.parent, leaf)?;
                if no_follow::identity(&published)? != self.payload_identity ||
                    observe(published, self.deadline, self.limit)? != (self.hash.clone(), self.bytes) {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                if let WriteExpected::Observed { .. } = &self.expected {
                    check_expected(&self.stage.file, "payload", &self.expected, self.deadline)?;
                }
                Ok(WriteObservation { parent: self.parent_identity.clone(), stage: self.stage.identity.clone(),
                    file: self.payload_identity.clone(), sha256: self.hash.clone(), bytes: self.bytes,
                    previous: self.expected.clone(), publication: "optimistic_namespace_publish" })
            };
            after().map_err(|_| Failure::Unknown)
        }
    }

    fn parent(root: &Root, parts: &[&str]) -> io::Result<File> {
        let (_, parents) = parts.split_last().ok_or(io::ErrorKind::InvalidInput)?;
        let mut current = root.file.try_clone()?;
        for part in parents {
            current = File::from(openat(&current, *part,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
        }
        Ok(current)
    }

    fn current_stage(stage: &Root, root: &Root) -> io::Result<()> {
        stage.current()?;
        let metadata = stage.file.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 ||
            metadata.dev() != root.file.metadata()?.dev() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }

    fn regular(parent: &File, leaf: &str) -> io::Result<File> {
        let file = File::from(openat(parent, leaf, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?);
        let stat = file.metadata()?;
        if !stat.is_file() || stat.nlink() != 1 { return Err(io::ErrorKind::InvalidInput.into()); }
        Ok(file)
    }

    fn check_expected(parent: &File, leaf: &str, expected: &WriteExpected, deadline: Instant) -> io::Result<()> {
        let file = regular(parent, leaf);
        match expected {
            WriteExpected::Missing => match file {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                _ => Err(io::ErrorKind::AlreadyExists.into()),
            },
            WriteExpected::Observed { identity, sha256, bytes } => {
                let file = file?;
                if no_follow::identity(&file)? != *identity || observe(file, deadline, SCAN_LIMIT)? != (sha256.clone(), *bytes) {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                Ok(())
            },
        }
    }

    fn observe(mut file: File, deadline: Instant, limit: u64) -> io::Result<(String, u64)> {
        let before = no_follow::stamp(&file)?;
        if file.metadata()?.len() > limit { return Err(io::ErrorKind::InvalidData.into()); }
        let mut bytes = 0u64;
        let mut hash = Sha256::new();
        let mut buffer = [0; 65_536];
        loop {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            let read = file.read(&mut buffer)?;
            if read == 0 { break; }
            bytes += read as u64;
            if bytes > limit { return Err(io::ErrorKind::InvalidData.into()); }
            hash.update(&buffer[..read]);
        }
        if no_follow::stamp(&file)? != before { return Err(io::ErrorKind::InvalidData.into()); }
        Ok((format!("{:x}", hash.finalize()), bytes))
    }

    fn sync_directory(directory: &File) -> io::Result<()> {
        File::from(openat(directory, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?).sync_all()
    }

    pub fn inspect_destination(root: &Root, relative: &str, deadline_ms: u64) -> io::Result<Identity> {
        if deadline_ms == 0 || deadline_ms > 30_000 { return Err(io::ErrorKind::InvalidInput.into()); }
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        root.current()?;
        let parts = no_follow::relative(relative)?;
        let parent = parent(root, &parts)?;
        let identity = no_follow::identity(&parent)?;
        check_expected(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, &WriteExpected::Missing, deadline)?;
        root.current()?;
        if no_follow::identity(&self::parent(root, &parts)?)? != identity || Instant::now() >= deadline {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(identity)
    }

    pub fn cleanup(root: &Root, stage: &str, identity: &Identity) -> io::Result<()> {
        let path = PathBuf::from(stage);
        if path.starts_with(&root.path) || root.path.starts_with(&path) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let stage = Root::open(stage, identity.clone())?;
        current_stage(&stage, root)?;
        // This fixed name is the only object this helper can create. Never walk or recursively
        // remove a supplied tree, and never run cleanup after an unknown namespace result.
        match regular(&stage.file, "payload") {
            Ok(file) => { drop(file); unlinkat(&stage.file, "payload", AtFlags::empty())?; },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
        sync_directory(&stage.file)?;
        current_stage(&stage, root)?;
        if std::fs::read_dir(&stage.path)?.next().is_some() { return Err(io::ErrorKind::DirectoryNotEmpty.into()); }
        stage.current()
    }
}

#[cfg(any(target_vendor = "apple", target_os = "linux"))]
pub use native::Prepared;
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
pub use native::{cleanup, inspect_destination};

#[cfg(windows)]
pub use crate::write_windows::{Prepared, cleanup, inspect_destination};

// Source availability is not platform validation. Unsupported platforms cannot silently
// fall back to truncation, ordinary replacement, or an unsandboxed helper.
#[cfg(not(any(target_vendor = "apple", target_os = "linux", windows)))]
pub struct Prepared;
#[cfg(not(any(target_vendor = "apple", target_os = "linux", windows)))]
impl Prepared {
    pub fn prepare(_: &Root, _: &str, _: &str, _: &str, _: &Identity, _: &str, _: &WriteExpected, _: u64) -> io::Result<Self> {
        Err(io::ErrorKind::Unsupported.into())
    }
    pub fn prepare_binary(_: &Root, _: &str, _: &str, _: &str, _: &Identity, _: u64, _: &str, _: u64) -> io::Result<Self> {
        Err(io::ErrorKind::Unsupported.into())
    }
    pub fn id(&self) -> &str { "" }
    pub fn description(&self) -> crate::protocol::WritePreparation { unreachable!() }
    pub fn publish(self, _: &Root) -> Result<WriteObservation, Failure> { Err(Failure::BeforePublish) }
}
#[cfg(not(any(target_vendor = "apple", target_os = "linux", windows)))]
pub fn cleanup(_: &Root, _: &str, _: &Identity) -> io::Result<()> { Err(io::ErrorKind::Unsupported.into()) }

#[cfg(not(any(target_vendor = "apple", target_os = "linux", windows)))]
pub fn inspect_destination(_: &Root, _: &str, _: u64) -> io::Result<Identity> { Err(io::ErrorKind::Unsupported.into()) }
