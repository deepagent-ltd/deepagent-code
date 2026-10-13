//! A private raw-object tree constructor. It never invokes Git, filters, hooks or a command.
//! The Host pins the original committed object manifest before creating this Native lease.
use crate::{no_follow, protocol::{Identity, PathRule}, root::Root};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::File, io::{self, Read, Write}, time::{Duration, Instant}};
#[cfg(windows)]
#[path = "event_worktree_windows.rs"]
mod windows;
#[cfg(windows)]
#[path = "event_worktree_windows_observation.rs"]
pub(crate) mod windows_observation;

pub const FILES: u64 = 8192;
pub const BYTES: u64 = 67_108_864;
pub const BLOB: u64 = 16_777_216;
pub const CHUNK: usize = 16_384;
pub const DIRECTORIES: usize = 16_384;
pub const DEADLINE_MS: u64 = 180_000;
pub const CUSTODY: u64 = 536_870_912;

#[derive(Serialize)]
pub struct Receipt { pub root: Identity, pub files: u64, pub bytes: u64, pub manifest_sha256: String, pub allocated_bytes: u64 }
pub enum Failure { BeforePublish, Unknown }

pub struct Tree {
    files: u64, bytes: u64, expected: String, deadline: Instant,
    names: BTreeSet<String>, directories: BTreeSet<String>, total: u64, published: u64, manifest: Sha256,
    active: Option<Leaf>, failed: bool,
    observations: Vec<Published>,
    #[cfg(windows)] lease: windows::Lease,
}
struct Published { relative: String, identity: Identity, parent_identity: Identity, bytes: u64, sha256: String }
struct Leaf {
    relative: String, temporary: String, file: File, parent: File, parent_identity: Identity,
    identity: Identity, bytes: u64, expected: String, written: u64, hash: Sha256, executable: bool,
}

impl Tree {
    pub fn begin(root: &Root, files: u64, bytes: u64, hash: &str, deadline_ms: u64) -> io::Result<Self> {
        if files > FILES || files == 0 && bytes != 0 || bytes > BYTES || !digest(hash) || deadline_ms == 0 || deadline_ms > DEADLINE_MS {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        root.current()?;
        let unit = headroom(root, CUSTODY)?;
        if bytes.checked_add((files + DIRECTORIES as u64).saturating_mul(unit)).is_none_or(|bound| bound > CUSTODY) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        #[cfg(windows)] let lease = windows::Lease::open(root)?;
        inventory(root, &BTreeSet::new(), Instant::now() + Duration::from_millis(deadline_ms))?;
        #[cfg(windows)] lease.harden(root)?;
        #[cfg(unix)] prepare_private_root(root)?;
        Ok(Self { files, bytes, expected: hash.to_owned(), deadline: Instant::now() + Duration::from_millis(deadline_ms),
            names: BTreeSet::new(), directories: BTreeSet::new(), total: 0, published: 0, manifest: Sha256::new(), active: None, failed: false,
            observations: Vec::new(), #[cfg(windows)] lease })
    }
    fn current(&self, root: &Root) -> io::Result<()> {
        if self.failed || Instant::now() >= self.deadline { return Err(io::ErrorKind::TimedOut.into()); }
        root.current()?;
        #[cfg(windows)] { self.lease.current(root) }
        #[cfg(unix)] { private_root(root) }
    }
    pub fn leaf(&mut self, root: &Root, id: &str, relative: &str, bytes: u64, hash: &str, executable: bool) -> io::Result<()> {
        self.current(root)?;
        let parts = no_follow::relative(relative)?;
        if self.active.is_some() || self.names.len() as u64 >= self.files || relative.len() > 2048 || parts.len() > 32 ||
            id.is_empty() || id.len() > 128 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') ||
            parts.iter().any(|part| part.eq_ignore_ascii_case(".git") || part.starts_with(".dac-tree-")) || !digest(hash) || bytes > BLOB ||
            self.total.checked_add(bytes).is_none_or(|total| total > self.bytes) ||
            self.names.iter().any(|name| name == relative || name.starts_with(&format!("{relative}/")) || relative.starts_with(&format!("{name}/"))) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        #[cfg(windows)] if self.names.iter().map(|name| name.to_uppercase()).any(|name| {
            let candidate = relative.to_uppercase(); name == candidate || name.starts_with(&format!("{candidate}/")) || candidate.starts_with(&format!("{name}/"))
        }) { return Err(io::ErrorKind::InvalidInput.into()); }
        let directories = (1..parts.len()).map(|index| parts[..index].join("/")).collect::<Vec<_>>();
        if self.directories.len() + directories.iter().filter(|name| !self.directories.contains(*name)).count() > DIRECTORIES {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        #[cfg(windows)] let parent = self.lease.parent(&parts, true)?;
        #[cfg(unix)] let parent = parent(root, &parts, true)?;
        let parent_identity = no_follow::identity(&parent)?;
        let temporary = format!(".dac-tree-{id}");
        if parts.last().is_none_or(|name| *name == temporary) { return Err(io::ErrorKind::InvalidInput.into()); }
        let file = create(&parent, &temporary)?;
        let identity = no_follow::identity(&file)?;
        self.names.insert(relative.to_owned()); self.directories.extend(directories); self.total += bytes;
        self.active = Some(Leaf { relative: relative.to_owned(), temporary, file, parent, parent_identity, identity,
            bytes, expected: hash.to_owned(), written: 0, hash: Sha256::new(), executable });
        self.current(root)
    }
    pub fn chunk(&mut self, root: &Root, offset: u64, hex: &str) -> io::Result<()> {
        self.current(root)?;
        if hex.is_empty() || hex.len() > CHUNK * 2 || hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let leaf = self.active.as_mut().ok_or(io::ErrorKind::InvalidInput)?;
        if offset != leaf.written || leaf.written.checked_add((hex.len() / 2) as u64).is_none_or(|bytes| bytes > leaf.bytes) ||
            no_follow::identity(&leaf.file)? != leaf.identity || no_follow::identity(&leaf.parent)? != leaf.parent_identity {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let value = hex.as_bytes().chunks_exact(2).map(|pair| (nibble(pair[0]) << 4) | nibble(pair[1])).collect::<Vec<_>>();
        leaf.file.write_all(&value)?; leaf.hash.update(&value); leaf.written += value.len() as u64;
        self.current(root)
    }
    pub fn publish(&mut self, root: &Root) -> Result<(), Failure> {
        self.current(root).inspect_err(|error| materialize_failure("publish-current", error)).map_err(|_| Failure::BeforePublish)?;
        let leaf = self.active.take().ok_or(Failure::BeforePublish)?;
        let parts = no_follow::relative(&leaf.relative).map_err(|_| Failure::BeforePublish)?;
        let deadline = self.deadline;
        let checked = || -> io::Result<()> {
            root.current().inspect_err(|error| materialize_failure("publish-root", error))?;
            #[cfg(windows)] self.lease.current(root).inspect_err(|error| materialize_failure("publish-lease", error))?;
            #[cfg(unix)] private_root(root)?;
            #[cfg(windows)] let observed_parent = self.lease.parent_existing(&parts).inspect_err(|error| materialize_failure("publish-parent", error))?;
            #[cfg(unix)] let observed_parent = parent(root, &parts, false)?;
            if leaf.written != leaf.bytes || format!("{:x}", leaf.hash.clone().finalize()) != leaf.expected ||
                no_follow::identity(&leaf.file)? != leaf.identity || no_follow::identity(&observed_parent)? != leaf.parent_identity ||
                Instant::now() >= deadline {
                let error = io::ErrorKind::InvalidData.into(); materialize_failure("publish-identity", &error); return Err(error);
            }
            leaf.file.sync_all().inspect_err(|error| materialize_failure("publish-sync", error))?;
            mode(&leaf.file, leaf.executable).inspect_err(|error| materialize_failure("publish-mode", error))
        };
        if checked().is_err() { self.failed = true; return Err(Failure::BeforePublish); }
        // The name publication is one-shot and refuses an existing leaf. A lost post-syscall
        // observation is unknown, never permission to overwrite or recreate the tree.
        publish(&leaf.file, &leaf.parent, &leaf.temporary, parts.last().ok_or(Failure::BeforePublish)?)
            .map_err(|error| { materialize_failure("publish-rename", &error); self.failed = true; Failure::BeforePublish })?;
        self.published += 1;
        let mut after = || -> io::Result<()> {
            checked()?;
            directory_sync(&leaf.parent).inspect_err(|error| materialize_failure("publish-parent-sync", error))?;
            if no_follow::identity(&no_follow::open_relative(&root.file, &parts)
                .inspect_err(|error| materialize_failure("publish-observe", error))?)? != leaf.identity {
                return Err(io::ErrorKind::InvalidData.into());
            }
            self.manifest.update((leaf.relative.len() as u32).to_be_bytes()); self.manifest.update(leaf.relative.as_bytes());
            self.manifest.update(leaf.bytes.to_be_bytes()); self.manifest.update(leaf.expected.as_bytes());
            self.manifest.update([u8::from(leaf.executable)]); Ok(())
        };
        if after().is_err() { self.failed = true; return Err(Failure::Unknown); }
        self.observations.push(Published { relative: leaf.relative, identity: leaf.identity, parent_identity: leaf.parent_identity,
            bytes: leaf.bytes, sha256: leaf.expected });
        Ok(())
    }
    pub fn finish(self, root: &Root) -> io::Result<Receipt> {
        self.current(root)?;
        if self.active.is_some() || self.published != self.files || self.total != self.bytes ||
            format!("{:x}", self.manifest.clone().finalize()) != self.expected { return Err(io::ErrorKind::InvalidData.into()); }
        // This is a bounded stream observation of every published descriptor, not a claim
        // that the filesystem supplied an atomic snapshot or that metadata hashes content.
        let mut stamps = Vec::new();
        for observed in &self.observations {
            self.current(root)?;
            let parts = no_follow::relative(&observed.relative)?;
            #[cfg(windows)] let parent = self.lease.parent_existing(&parts)?;
            #[cfg(unix)] let parent = parent(root, &parts, false)?;
            let mut file = no_follow::open_relative(&root.file, &parts)?;
            let stamp = no_follow::stamp(&file)?;
            if no_follow::identity(&parent)? != observed.parent_identity || no_follow::identity(&file)? != observed.identity ||
                file.metadata()?.len() != observed.bytes { return Err(io::ErrorKind::InvalidData.into()); }
            let mut hash = Sha256::new(); let mut bytes = 0u64; let mut buffer = [0; 65_536];
            loop {
                self.current(root)?;
                let count = file.read(&mut buffer)?;
                if count == 0 { break; }
                bytes = bytes.checked_add(count as u64).ok_or(io::ErrorKind::InvalidData)?;
                if bytes > observed.bytes { return Err(io::ErrorKind::InvalidData.into()); }
                hash.update(&buffer[..count]);
            }
            if bytes != observed.bytes || format!("{:x}", hash.finalize()) != observed.sha256 || no_follow::stamp(&file)? != stamp ||
                no_follow::stamp(&no_follow::open_relative(&root.file, &parts)?)? != stamp { return Err(io::ErrorKind::InvalidData.into()); }
            stamps.push((observed.relative.as_str(), stamp));
        }
        inventory(root, &self.names, self.deadline)?;
        for (relative, stamp) in stamps {
            self.current(root)?;
            if no_follow::stamp(&no_follow::open_relative(&root.file, &no_follow::relative(relative)?)?)? != stamp {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        directory_sync(&root.file)?; self.current(root)?;
        let allocated_bytes = allocated(root, &self.names, self.deadline)?;
        if allocated_bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); }
        Ok(Receipt { root: root.identity.clone(), files: self.files, bytes: self.bytes, manifest_sha256: self.expected, allocated_bytes })
    }
    pub fn invalid(&mut self) { self.failed = true; }
    pub fn partial(&self) -> bool { self.published > 0 }
}

fn materialize_failure(stage: &'static str, error: &io::Error) {
    #[cfg(windows)] eprintln!("DAC_EVENT_WINDOWS_FS_PHASE {stage} {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0));
    #[cfg(not(windows))] let _ = (stage, error);
}

fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
fn nibble(byte: u8) -> u8 { if byte.is_ascii_digit() { byte - b'0' } else { byte - b'a' + 10 } }

/// A separate read-only custody observation. It cannot create or modify leaves, and
/// a complete exact inventory fence rejects unaccounted command/foreign outputs.
pub struct ObservedTree {
    deadline: Instant, names: BTreeSet<String>, observations: Vec<(String, String, bool)>, bytes: u64,
    baseline: Option<(Vec<PathRule>, Vec<PathRule>, BTreeSet<String>)>,
}
impl ObservedTree {
    pub(crate) fn observed_stamps(&self) -> Vec<(String, String)> {
        self.observations.iter().map(|(name, stamp, _)| (name.clone(), stamp.clone())).collect()
    }
    pub fn begin(root: &Root, deadline_ms: u64) -> io::Result<Self> {
        if deadline_ms == 0 || deadline_ms > 180_000 { return Err(io::ErrorKind::InvalidInput.into()); }
        root.current()?; private_root(root)?;
        Ok(Self { deadline: Instant::now() + Duration::from_millis(deadline_ms), names: BTreeSet::new(), observations: Vec::new(), bytes: 0, baseline: None })
    }
    pub fn baseline(root: &Root, read: Vec<PathRule>, deny: Vec<PathRule>, deadline_ms: u64) -> io::Result<Self> {
        if deadline_ms == 0 || deadline_ms > DEADLINE_MS || read.len() > 128 || deny.len() > 128 || read.is_empty() ||
            read.iter().chain(&deny).any(|rule| !matches!(rule.kind.as_str(), "file" | "tree") ||
                rule.path.len() > 2048 || no_follow::relative(&rule.path).is_err() || rule.path.split('/').count() > 32) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        let names = scoped_inventory(root, &read, &deny, deadline)?;
        Ok(Self { deadline, names: BTreeSet::new(), observations: Vec::new(), bytes: 0, baseline: Some((read, deny, names)) })
    }
    pub fn names_page(&self, offset: usize) -> io::Result<(Vec<u8>, bool)> {
        if Instant::now() >= self.deadline { return Err(io::ErrorKind::TimedOut.into()); }
        let names = &self.baseline.as_ref().ok_or(io::ErrorKind::InvalidInput)?.2;
        if offset > names.len() { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut payload = Vec::new(); let mut count = 0usize;
        for name in names.iter().skip(offset) {
            if payload.len() + name.len() + 1 > 51_200 { break; }
            payload.extend_from_slice(name.as_bytes()); payload.push(0); count += 1;
        }
        Ok((payload, offset + count == names.len()))
    }
    pub fn leaf(&mut self, root: &Root, relative: &str) -> io::Result<(crate::protocol::Observation, bool)> {
        if Instant::now() >= self.deadline || self.names.len() >= FILES as usize || self.names.contains(relative) { return Err(io::ErrorKind::InvalidInput.into()); }
        root.current()?;
        if self.baseline.as_ref().is_some_and(|scope| !scope.2.contains(relative)) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let parts = no_follow::relative(relative)?;
        if relative.len() > 2048 || parts.len() > 32 || parts.iter().any(|name| name.eq_ignore_ascii_case(".git") || name.starts_with(".dac-tree-")) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let file = no_follow::open_relative(&root.file, &parts)?;
        #[cfg(unix)] let executable = { use std::os::unix::fs::PermissionsExt; file.metadata()?.permissions().mode() & 0o111 != 0 };
        #[cfg(windows)] let executable = false;
        let stamp = no_follow::stamp(&file)?;
        let observed = root.observe(relative, BLOB, self.deadline.saturating_duration_since(Instant::now()).as_millis().min(30_000) as u64)?;
        if no_follow::stamp(&file)? != stamp || observed.file_bytes > BLOB || self.bytes.checked_add(observed.file_bytes).filter(|value| *value <= BYTES).is_none() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.bytes += observed.file_bytes; self.names.insert(relative.to_owned());
        self.observations.push((relative.to_owned(), stamp, executable));
        Ok((observed, executable))
    }
    pub fn finish(self, root: &Root) -> io::Result<Receipt> {
        root.current()?;
        if let Some((read, deny, names)) = &self.baseline {
            if names != &self.names || scoped_inventory(root, read, deny, self.deadline)? != *names { return Err(io::ErrorKind::InvalidData.into()); }
        } else { inventory(root, &self.names, self.deadline)?; }
        let mut hash = Sha256::new(); let mut bytes = 0u64;
        for (relative, stamp, executable) in &self.observations {
            if Instant::now() >= self.deadline { return Err(io::ErrorKind::TimedOut.into()); }
            root.current()?;
            let file = no_follow::open_relative(&root.file, &no_follow::relative(&relative)?)?;
            if &no_follow::stamp(&file)? != stamp { return Err(io::ErrorKind::InvalidData.into()); }
            let observed = root.observe(&relative, BLOB, self.deadline.saturating_duration_since(Instant::now()).as_millis().min(30_000) as u64)?;
            hash.update((relative.len() as u32).to_be_bytes()); hash.update(relative.as_bytes()); hash.update(observed.file_bytes.to_be_bytes());
            hash.update(observed.observed_sha256.as_bytes()); hash.update([u8::from(*executable)]);
            bytes += observed.file_bytes;
            if &no_follow::stamp(&file)? != stamp { return Err(io::ErrorKind::InvalidData.into()); }
        }
        root.current()?;
        if let Some((read, deny, names)) = &self.baseline {
            if scoped_inventory(root, read, deny, self.deadline)? != *names { return Err(io::ErrorKind::InvalidData.into()); }
        } else { inventory(root, &self.names, self.deadline)?; }
        if bytes != self.bytes { return Err(io::ErrorKind::InvalidData.into()); }
        let allocated_bytes = allocated(root, &self.names, self.deadline)?;
        if allocated_bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); }
        for (relative, stamp, _) in &self.observations {
            if Instant::now() >= self.deadline || &no_follow::stamp(&no_follow::open_relative(&root.file, &no_follow::relative(relative)?)?)? != stamp {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        root.current()?;
        Ok(Receipt { root: root.identity.clone(), files: self.names.len() as u64, bytes, manifest_sha256: format!("{:x}", hash.finalize()), allocated_bytes })
    }
}

#[cfg(unix)]
pub fn headroom(root: &Root, reservation: u64) -> io::Result<u64> {
    use std::os::fd::AsRawFd;
    root.current()?;
    if reservation == 0 || reservation > 4_294_967_296 { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut value: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatvfs(root.file.as_raw_fd(), &mut value) } != 0 { return Err(io::Error::last_os_error()); }
    let unit = u64::try_from(value.f_frsize).map_err(|_| io::ErrorKind::InvalidData)?;
    if unit == 0 || u128::from(value.f_bavail) * u128::from(unit) < u128::from(reservation) { return Err(io::ErrorKind::StorageFull.into()); }
    root.current()?; Ok(unit)
}
#[cfg(windows)]
pub fn headroom(root: &Root, reservation: u64) -> io::Result<u64> { windows_observation::headroom(root, reservation) }

pub fn git_allocation_bound(unit: u64, reservation: u64, plan: &crate::protocol::GitAllocationPlan) -> io::Result<()> {
    if plan.files > FILES || plan.directories > DIRECTORIES as u64 || plan.bytes > BYTES || plan.index_bytes > BLOB ||
        plan.existing_bytes > CUSTODY || unit == 0 { return Err(io::ErrorKind::InvalidInput.into()); }
    // Git's raw zlib objects have bounded compression expansion, one allocation rounding
    // per object/tree, at most 256 loose buckets, and fixed ref/admin metadata. This is a
    // conservative admission bound, followed by the actual held-FD allocation ledger.
    let bound = u128::from(plan.existing_bytes) + u128::from(plan.bytes) + u128::from(plan.bytes / 1000) +
        u128::from(plan.files + plan.directories + 1) * 128 + u128::from(plan.index_bytes) * 2 +
        u128::from(plan.files + plan.directories + 274) * u128::from(unit);
    if bound > u128::from(reservation) { return Err(io::ErrorKind::StorageFull.into()); }
    Ok(())
}

#[cfg(unix)]
pub fn object_allocation(root: &Root, relative: &str) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    if relative == "@worktree" {
        use rustix::fs::{Dir, Mode, OFlags, openat};
        let readable = File::from(openat(&root.file, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
        if no_follow::identity(&readable)? != root.identity { return Err(io::ErrorKind::InvalidData.into()); }
        let allowed = ["HEAD", "index", "gitdir", "commondir", "ORIG_HEAD", "logs", "refs"];
        let names = Dir::read_from(&readable)?.map(|entry| entry.map(|value| value.file_name().to_bytes().to_vec())).collect::<Result<Vec<_>, _>>()?;
        if names.iter().filter(|name| name.as_slice() != b"." && name.as_slice() != b"..").any(|name|
            !allowed.iter().any(|value| value.as_bytes() == name)) { return Err(io::ErrorKind::InvalidData.into()); }
        let mut bytes = root.file.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?;
        let mut held = Vec::new();
        let mut directories = Vec::new();
        for name in allowed {
            if !names.iter().any(|value| value == name.as_bytes()) { continue; }
            // Git can create an empty per-worktree refs namespace during fixed raw
            // reads. It is accounted custody, never permission to add arbitrary refs.
            if name == "refs" {
                let directory = parent(root, &["refs", "held-empty"], false)?;
                let readable = File::from(openat(&directory, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
                if Dir::read_from(&readable)?.any(|entry| entry.map_or(true, |entry| {
                    let name = entry.file_name().to_bytes(); name != b"." && name != b".."
                })) { return Err(io::ErrorKind::InvalidData.into()); }
                bytes = bytes.checked_add(directory.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?).ok_or(io::ErrorKind::InvalidData)?;
                let stamp = no_follow::stamp(&directory)?; directories.push((directory, stamp));
                continue;
            }
            if name == "logs" {
                let directory = parent(root, &["logs", "HEAD"], false)?;
                for entry in Dir::read_from(&directory)? {
                    let entry = entry?; let name = entry.file_name().to_bytes();
                    if name != b"." && name != b".." && name != b"HEAD" { return Err(io::ErrorKind::InvalidData.into()); }
                }
                bytes = bytes.checked_add(directory.metadata()?.blocks() * 512).ok_or(io::ErrorKind::InvalidData)?;
            }
            let relative = if name == "logs" { "logs/HEAD" } else { name };
            let file = no_follow::open_relative(&root.file, &no_follow::relative(relative)?)?;
            let stamp = no_follow::stamp(&file)?; let metadata = file.metadata()?;
            if metadata.len() > if name == "index" { BLOB } else { 8192 } { return Err(io::ErrorKind::InvalidData.into()); }
            bytes = bytes.checked_add(metadata.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?).ok_or(io::ErrorKind::InvalidData)?;
            held.push((relative, file, stamp));
        }
        for (relative, file, stamp) in held {
            if no_follow::stamp(&file)? != stamp || no_follow::stamp(&no_follow::open_relative(&root.file, &no_follow::relative(relative)?)?)? != stamp {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        for (directory, stamp) in directories {
            if no_follow::stamp(&directory)? != stamp || no_follow::stamp(&parent(root, &["refs", "held-empty"], false)?)? != stamp {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        let after = Dir::read_from(&readable)?.map(|entry| entry.map(|value| value.file_name().to_bytes().to_vec())).collect::<Result<Vec<_>, _>>()?;
        if names.into_iter().collect::<BTreeSet<_>>() != after.into_iter().collect::<BTreeSet<_>>() { return Err(io::ErrorKind::InvalidData.into()); }
        root.current()?; return Ok(bytes);
    }
    if relative.is_empty() { root.current()?; return root.file.metadata()?.blocks().checked_mul(512).ok_or_else(|| io::ErrorKind::InvalidData.into()); }
    if relative.len() == 2 && relative.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) {
        root.current()?;
        let directory = parent(root, &[relative, "held-object"], false)?;
        let bytes = directory.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?;
        if no_follow::identity(&directory)? != no_follow::identity(&parent(root, &[relative, "held-object"], false)?)? { return Err(io::ErrorKind::InvalidData.into()); }
        root.current()?; return Ok(bytes);
    }
    let (prefix, name) = relative.split_once('/').ok_or(io::ErrorKind::InvalidInput)?;
    if prefix.len() != 2 || ![38, 62].contains(&name.len()) || !prefix.bytes().chain(name.bytes()).all(|value|
        value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) { return Err(io::ErrorKind::InvalidInput.into()); }
    root.current()?;
    let file = no_follow::open_relative(&root.file, &[prefix, name])?;
    let stamp = no_follow::stamp(&file)?; let metadata = file.metadata()?;
    let bytes = metadata.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?;
    if metadata.len() > 33_554_432 || bytes > CUSTODY || no_follow::stamp(&file)? != stamp ||
        no_follow::stamp(&no_follow::open_relative(&root.file, &[prefix, name])?)? != stamp { return Err(io::ErrorKind::InvalidData.into()); }
    root.current()?; Ok(bytes)
}
#[cfg(windows)]
pub fn object_allocation(root: &Root, relative: &str) -> io::Result<u64> { windows_observation::object_allocation(root, relative) }

#[cfg(unix)]
fn allocated(root: &Root, names: &BTreeSet<String>, deadline: Instant) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    root.current()?;
    let mut directories = BTreeSet::new(); let mut bytes = root.file.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?;
    for relative in names {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        root.current()?;
        let parts = no_follow::relative(relative)?;
        let file = no_follow::open_relative(&root.file, &parts)?;
        bytes = bytes.checked_add(file.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?).ok_or(io::ErrorKind::InvalidData)?;
        for index in 1..parts.len() {
            let name = parts[..index].join("/");
            if directories.insert(name) {
                let directory = parent(root, &parts[..=index], false)?;
                bytes = bytes.checked_add(directory.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?).ok_or(io::ErrorKind::InvalidData)?;
            }
        }
        if bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); }
    }
    if let Ok(pointer) = no_follow::open_relative(&root.file, &[".git"]) {
        bytes = bytes.checked_add(pointer.metadata()?.blocks().checked_mul(512).ok_or(io::ErrorKind::InvalidData)?).ok_or(io::ErrorKind::InvalidData)?;
    }
    root.current()?; Ok(bytes)
}
#[cfg(windows)]
fn allocated(root: &Root, names: &BTreeSet<String>, deadline: Instant) -> io::Result<u64> { windows_observation::allocated(root, names, deadline) }

fn matches_path(rule: &PathRule, relative: &str) -> bool {
    relative == rule.path || rule.kind == "tree" && relative.starts_with(&format!("{}/", rule.path))
}
#[cfg(unix)]
fn scoped_inventory(root: &Root, read: &[PathRule], deny: &[PathRule], deadline: Instant) -> io::Result<BTreeSet<String>> {
    use rustix::fs::{Dir, Mode, OFlags, openat};
    use std::os::unix::fs::MetadataExt;
    root.current()?;
    let readable = File::from(openat(&root.file, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
    if no_follow::identity(&readable)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut pending = vec![(String::new(), readable)]; let mut names = BTreeSet::new(); let mut entries = 0usize;
    while let Some((prefix, parent)) = pending.pop() {
        root.current()?;
        for entry in Dir::read_from(&parent)? {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            let entry = entry?; let name = entry.file_name().to_str().map_err(|_| io::ErrorKind::InvalidData)?;
            if name == "." || name == ".." || name.eq_ignore_ascii_case(".git") { continue; }
            let relative = if prefix.is_empty() { name.to_owned() } else { format!("{prefix}/{name}") };
            if deny.iter().any(|rule| matches_path(rule, &relative)) || !read.iter().any(|rule|
                matches_path(rule, &relative) || rule.path.starts_with(&format!("{relative}/"))) { continue; }
            if relative.len() > 2048 || relative.split('/').count() > 32 || no_follow::relative(&relative).is_err() ||
                name.starts_with(".dac-tree-") || name == ".env" || name.starts_with(".env.") || name == "auth.json" ||
                matches!(name, "credentials" | "credentials.json" | ".ssh" | ".aws") || name.ends_with(".pem") || name.ends_with(".key") {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            entries += 1; if entries > FILES as usize + DIRECTORIES { return Err(io::ErrorKind::InvalidInput.into()); }
            let file = File::from(openat(&parent, name, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?);
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                if read.iter().any(|rule| rule.kind == "file" && rule.path == relative) { return Err(io::ErrorKind::InvalidData.into()); }
                pending.push((relative, file)); continue;
            }
            if !metadata.is_file() || metadata.nlink() != 1 || !read.iter().any(|rule| matches_path(rule, &relative)) ||
                names.len() >= FILES as usize || !names.insert(relative) { return Err(io::ErrorKind::InvalidData.into()); }
        }
    }
    root.current()?; Ok(names)
}
#[cfg(windows)]
fn scoped_inventory(root: &Root, read: &[PathRule], deny: &[PathRule], deadline: Instant) -> io::Result<BTreeSet<String>> {
    windows_observation::scoped_inventory(root, read, deny, deadline)
}

#[cfg(unix)]
fn private_root(root: &Root) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let value = root.file.metadata()?;
    if !value.is_dir() || value.uid() != unsafe { libc::geteuid() } || value.mode() & 0o077 != 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}
#[cfg(windows)]
fn private_root(root: &Root) -> io::Result<()> {
    root.current()?;
    // The ordinary root handle intentionally lacks READ_CONTROL. Inspect its
    // private DACL through an independent read-only object anchored to that
    // original handle, never through a Volume-GUID or caller-selected path.
    let file = windows_observation::member(&root.file, ".", true)?;
    if no_follow::identity(&file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    crate::native_windows::private_directory::require_private(&file)?;
    root.current()
}

#[cfg(unix)]
fn prepare_private_root(root: &Root) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use rustix::fs::{Mode, OFlags, openat};
    root.current()?;
    let file = File::from(openat(&root.file, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
    if no_follow::identity(&file)? != root.identity || file.metadata()?.uid() != unsafe { libc::geteuid() } {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // Only the exact empty (or .git-only) original child can be hardened. No existing
    // project tree, parent directory, owner or path-selected foreign inode is modified.
    file.set_permissions(std::fs::Permissions::from_mode(0o700))?; directory_sync(&file)?;
    root.current()?; private_root(root)
}
#[cfg(unix)]
fn parent(root: &Root, parts: &[&str], create: bool) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, mkdirat, openat};
    use std::os::unix::fs::MetadataExt;
    let mut value = root.file.try_clone()?;
    for part in &parts[..parts.len()-1] {
        if create { match mkdirat(&value, *part, Mode::from_raw_mode(0o700)) {
            Ok(()) => { directory_sync(&value)?; }, Err(error) if error == rustix::io::Errno::EXIST => {}, Err(error) => return Err(error.into()),
        }
        }
        value = File::from(openat(&value, *part, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
        let stat = value.metadata()?;
        if stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o022 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    Ok(value)
}
#[cfg(unix)]
fn create(parent: &File, name: &str) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, openat};
    Ok(File::from(openat(parent, name, OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::from_raw_mode(0o600))?))
}
#[cfg(unix)]
fn mode(file: &File, executable: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }))
}
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
fn publish(_: &File, parent: &File, temporary: &str, name: &str) -> io::Result<()> {
    use rustix::fs::{RenameFlags, renameat_with};
    renameat_with(parent, temporary, parent, name, RenameFlags::NOREPLACE).map_err(Into::into)
}
#[cfg(unix)]
fn directory_sync(file: &File) -> io::Result<()> {
    // Ordinary Linux root descriptors use O_PATH. Sync a no-follow reopen of the same
    // owned directory rather than treating its intentionally limited FD as writable.
    use rustix::fs::{Mode, OFlags, openat};
    let opened = File::from(openat(file, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
    if no_follow::identity(&opened)? != no_follow::identity(file)? { return Err(io::ErrorKind::InvalidData.into()); }
    opened.sync_all()
}
#[cfg(windows)]
fn directory_sync(_: &File) -> io::Result<()> { Ok(()) }
#[cfg(windows)]
fn create(parent: &File, name: &str) -> io::Result<File> { windows::create(parent, name) }
#[cfg(windows)]
fn mode(file: &File, _: bool) -> io::Result<()> { crate::native_windows::private_directory::require_private(file) }
#[cfg(windows)]
fn publish(file: &File, parent: &File, _: &str, name: &str) -> io::Result<()> { windows::publish(file, parent, name) }

#[cfg(unix)]
fn inventory(root: &Root, names: &BTreeSet<String>, deadline: Instant) -> io::Result<()> {
    use rustix::fs::{Dir, Mode, OFlags, openat};
    let readable = File::from(openat(&root.file, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
    if no_follow::identity(&readable)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut pending = vec![(String::new(), readable)]; let mut seen = BTreeSet::new(); let mut entries = 0usize;
    while let Some((prefix, parent)) = pending.pop() {
        root.current()?;
        for entry in Dir::read_from(&parent)? {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            let entry = entry?; let name = entry.file_name().to_str().map_err(|_| io::ErrorKind::InvalidData)?;
            if name == "." || name == ".." { continue; }
            entries += 1; if entries > FILES as usize + DIRECTORIES + 1 { return Err(io::ErrorKind::InvalidInput.into()); }
            let relative = if prefix.is_empty() { name.to_owned() } else { format!("{prefix}/{name}") };
            let file = File::from(openat(&parent, name, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?);
            let metadata = file.metadata()?;
            if prefix.is_empty() && name == ".git" && metadata.is_file() { continue; }
            if metadata.is_dir() {
                if !names.iter().any(|value| value.starts_with(&format!("{relative}/"))) { return Err(io::ErrorKind::InvalidData.into()); }
                pending.push((relative, file)); continue;
            }
            if !metadata.is_file() || !names.contains(&relative) || !seen.insert(relative) { return Err(io::ErrorKind::InvalidData.into()); }
        }
    }
    root.current()?;
    if seen != *names { return Err(io::ErrorKind::InvalidData.into()); } Ok(())
}
#[cfg(windows)]
fn inventory(root: &Root, names: &BTreeSet<String>, deadline: Instant) -> io::Result<()> {
    windows_observation::inventory(root, names, deadline)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{os::unix::fs::{PermissionsExt, symlink}, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("dac-event-tree-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap(); std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap(); Self(path)
        }
        fn root(&self) -> Root { Root::inspect(self.0.to_str().unwrap()).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn sha(value: &[u8]) -> String { format!("{:x}", Sha256::digest(value)) }
    fn manifest(values: &[(&str, &[u8], bool)]) -> String {
        let mut hash = Sha256::new();
        for (name, body, executable) in values {
            hash.update((name.len() as u32).to_be_bytes()); hash.update(name.as_bytes()); hash.update((body.len() as u64).to_be_bytes());
            hash.update(sha(body).as_bytes()); hash.update([u8::from(*executable)]);
        }
        format!("{:x}", hash.finalize())
    }
    fn write(tree: &mut Tree, root: &Root, name: &str, bytes: &[u8], executable: bool, id: usize) {
        tree.leaf(root, &format!("leaf-{id}"), name, bytes.len() as u64, &sha(bytes), executable).unwrap();
        for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
            tree.chunk(root, (index * CHUNK) as u64, &chunk.iter().map(|byte| format!("{byte:02x}")).collect::<String>()).unwrap();
        }
        assert!(tree.publish(root).is_ok());
    }
    #[test]
    fn event_worktree_actual_257_files_publish_hash_modes_and_empty_blob() {
        let fixture = Fixture::new(); let root = fixture.root();
        let names = (0..257).map(|index| format!("src/{index:03}.txt")).collect::<Vec<_>>();
        let bodies = (0..257).map(|index| if index == 256 { Vec::new() } else { format!("file {index} \0 🌟").into_bytes() }).collect::<Vec<_>>();
        let values = names.iter().zip(&bodies).enumerate().map(|(index, (name, body))| (name.as_str(), body.as_slice(), index == 0)).collect::<Vec<_>>();
        let hash = manifest(&values); let bytes = bodies.iter().map(|body| body.len() as u64).sum();
        let mut tree = Tree::begin(&root, 257, bytes, &hash, 30_000).unwrap();
        for (index, (name, body, executable)) in values.iter().enumerate() { write(&mut tree, &root, name, body, *executable, index); }
        let receipt = tree.finish(&root).unwrap(); assert_eq!(receipt.files, 257); assert_eq!(receipt.bytes, bytes); assert_eq!(receipt.manifest_sha256, hash);
        for (index, name) in names.iter().enumerate() {
            assert_eq!(std::fs::read(fixture.0.join(name)).unwrap(), bodies[index]);
            assert_eq!(std::fs::metadata(fixture.0.join(name)).unwrap().permissions().mode() & 0o777, if index == 0 { 0o700 } else { 0o600 });
        }
    }
    #[test]
    fn event_custody_actual_loose_objects_and_directories_count_blocks_and_refuse_aliases() {
        use std::os::unix::fs::MetadataExt;
        let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("ab")).unwrap();
        let name = "c".repeat(38); let relative = format!("ab/{name}");
        std::fs::write(fixture.0.join(&relative), vec![0; 8193]).unwrap(); let root = fixture.root();
        assert_eq!(object_allocation(&root, &relative).unwrap(), std::fs::metadata(fixture.0.join(&relative)).unwrap().blocks() * 512);
        assert_eq!(object_allocation(&root, "ab").unwrap(), std::fs::metadata(fixture.0.join("ab")).unwrap().blocks() * 512);
        assert_eq!(object_allocation(&root, "").unwrap(), std::fs::metadata(&fixture.0).unwrap().blocks() * 512);
        assert!(headroom(&root, 268_435_456).unwrap() > 0);
        assert!(object_allocation(&root, "../outside").is_err());
        std::fs::hard_link(fixture.0.join(&relative), fixture.0.join("alias")).unwrap(); assert!(object_allocation(&root, &relative).is_err());
        std::fs::remove_file(fixture.0.join("alias")).unwrap(); std::fs::remove_file(fixture.0.join(&relative)).unwrap();
        symlink(std::env::temp_dir(), fixture.0.join(&relative)).unwrap(); assert!(object_allocation(&root, &relative).is_err());
    }
    #[test]
    fn event_custody_actual_worktree_metadata_and_before_write_allocation_bound() {
        use std::os::unix::fs::MetadataExt;
        let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("logs")).unwrap();
        for name in ["HEAD", "index", "gitdir", "commondir", "logs/HEAD"] { std::fs::write(fixture.0.join(name), vec![0; 8191]).unwrap(); }
        let root = fixture.root();
        let expected = ["", "logs", "HEAD", "index", "gitdir", "commondir", "logs/HEAD"].iter().map(|name|
            std::fs::metadata(fixture.0.join(name)).unwrap().blocks() * 512).sum::<u64>();
        assert_eq!(object_allocation(&root, "@worktree").unwrap(), expected);
        std::fs::create_dir(fixture.0.join("refs")).unwrap();
        assert_eq!(object_allocation(&root, "@worktree").unwrap(), expected + std::fs::metadata(fixture.0.join("refs")).unwrap().blocks() * 512);
        std::fs::write(fixture.0.join("refs/foreign"), b"foreign").unwrap(); assert!(object_allocation(&root, "@worktree").is_err());
        std::fs::remove_file(fixture.0.join("refs/foreign")).unwrap(); std::fs::remove_dir(fixture.0.join("refs")).unwrap();
        symlink(std::env::temp_dir(), fixture.0.join("refs")).unwrap(); assert!(object_allocation(&root, "@worktree").is_err());
        std::fs::remove_file(fixture.0.join("refs")).unwrap();
        std::fs::write(fixture.0.join("foreign"), b"foreign").unwrap(); assert!(object_allocation(&root, "@worktree").is_err());
        let plan = crate::protocol::GitAllocationPlan { files: FILES, directories: DIRECTORIES as u64, bytes: BYTES,
            index_bytes: BLOB, existing_bytes: 0 };
        assert!(git_allocation_bound(4096, 268_435_456, &plan).is_ok());
        assert!(git_allocation_bound(65_536, 268_435_456, &plan).is_err());
        assert!(git_allocation_bound(4096, 268_435_456, &crate::protocol::GitAllocationPlan { existing_bytes: 268_435_456, ..plan }).is_err());
    }
    #[test]
    fn event_worktree_no_overwrite_alias_symlink_or_empty_progress() {
        let fixture = Fixture::new(); let root = fixture.root(); let hash = manifest(&[("file", b"ok", false)]);
        let mut tree = Tree::begin(&root, 1, 2, &hash, 30_000).unwrap();
        tree.leaf(&root, "leaf", "file", 2, &sha(b"ok"), false).unwrap(); tree.chunk(&root, 0, "6f6b").unwrap();
        std::fs::write(fixture.0.join("file"), b"old").unwrap();
        assert!(matches!(tree.publish(&root), Err(Failure::BeforePublish))); assert_eq!(std::fs::read(fixture.0.join("file")).unwrap(), b"old");
        let fixture = Fixture::new(); let root = fixture.root(); let mut tree = Tree::begin(&root, 2, 4, &hash, 30_000).unwrap();
        write(&mut tree, &root, "parent", b"ok", false, 0);
        assert!(tree.leaf(&root, "bad", "parent/child", 2, &sha(b"ok"), false).is_err());
        assert!(tree.leaf(&root, "bad", "../foreign", 2, &sha(b"ok"), false).is_err());
        assert!(tree.leaf(&root, "bad", ".git/config", 2, &sha(b"ok"), false).is_err());
        assert!(tree.leaf(&root, "../bad", "fine", 2, &sha(b"ok"), false).is_err());
        symlink(std::env::temp_dir(), fixture.0.join("link")).unwrap();
        assert!(tree.leaf(&root, "bad", "link/escape", 2, &sha(b"ok"), false).is_err());
        tree.leaf(&root, "good", "fine", 2, &sha(b"ok"), false).unwrap(); assert!(tree.chunk(&root, 0, "").is_err());
    }
    #[test]
    fn event_worktree_actual_post_publication_body_and_hardlink_changes_refuse_final() {
        for hardlink in [false, true] {
            let fixture = Fixture::new(); let root = fixture.root(); let hash = manifest(&[("file", b"ok", false)]);
            let mut tree = Tree::begin(&root, 1, 2, &hash, 30_000).unwrap(); write(&mut tree, &root, "file", b"ok", false, 0);
            if hardlink { std::fs::hard_link(fixture.0.join("file"), fixture.0.join("alias")).unwrap(); }
            else { std::fs::write(fixture.0.join("file"), b"NO").unwrap(); }
            assert!(tree.partial()); assert!(tree.finish(&root).is_err());
        }
    }
    #[test]
    fn event_worktree_current_root_expiry_and_missing_parent_never_recreate() {
        let fixture = Fixture::new(); let root = fixture.root(); let hash = manifest(&[("parent/file", b"ok", false)]);
        let mut tree = Tree::begin(&root, 1, 2, &hash, 30_000).unwrap(); tree.leaf(&root, "leaf", "parent/file", 2, &sha(b"ok"), false).unwrap();
        tree.chunk(&root, 0, "6f6b").unwrap(); std::fs::rename(fixture.0.join("parent"), fixture.0.join("moved")).unwrap();
        assert!(matches!(tree.publish(&root), Err(Failure::BeforePublish))); assert!(!fixture.0.join("parent").exists());
        let fixture = Fixture::new(); let root = fixture.root();
        let mut tree = Tree::begin(&root, 1, 2, &hash, 1).unwrap(); std::thread::sleep(Duration::from_millis(3));
        assert!(tree.leaf(&root, "leaf", "file", 2, &sha(b"ok"), false).is_err());
        let mut tree = Tree::begin(&root, 1, 2, &hash, 30_000).unwrap();
        let moved = fixture.0.with_extension("moved"); std::fs::rename(&fixture.0, &moved).unwrap(); std::fs::create_dir(&fixture.0).unwrap();
        assert!(tree.leaf(&root, "leaf", "file", 2, &sha(b"ok"), false).is_err()); std::fs::remove_dir_all(moved).unwrap();
    }
    #[test]
    fn event_worktree_capacity_hash_and_actual_chunk_offset_refuse() {
        let fixture = Fixture::new(); let root = fixture.root(); let hash = manifest(&[("file", b"ok", false)]);
        assert!(Tree::begin(&root, FILES+1, 2, &hash, 30_000).is_err()); assert!(Tree::begin(&root, 1, BYTES+1, &hash, 30_000).is_err());
        let mut tree = Tree::begin(&root, 1, 2, &hash, 30_000).unwrap();
        assert!(tree.leaf(&root, "large", "large", BLOB+1, &sha(b"ok"), false).is_err());
        tree.leaf(&root, "leaf", "file", 2, &sha(b"NO"), false).unwrap(); assert!(tree.chunk(&root, 1, "6f6b").is_err());
        tree.chunk(&root, 0, "6f6b").unwrap(); assert!(matches!(tree.publish(&root), Err(Failure::BeforePublish))); assert!(!fixture.0.join("file").exists());
    }
    #[test]
    fn event_worktree_actual_inventory_rejects_foreign_leaves_and_can_prove_empty_tree() {
        let fixture = Fixture::new(); let root = fixture.root(); let hash = manifest(&[("file", b"ok", false)]);
        std::fs::write(fixture.0.join("foreign"), b"foreign").unwrap(); assert!(Tree::begin(&root, 1, 2, &hash, 30_000).is_err());
        std::fs::remove_file(fixture.0.join("foreign")).unwrap();
        let mut tree = Tree::begin(&root, 1, 2, &hash, 30_000).unwrap(); write(&mut tree, &root, "file", b"ok", false, 0);
        std::fs::write(fixture.0.join("foreign"), b"foreign").unwrap(); assert!(tree.finish(&root).is_err());
        let fixture = Fixture::new(); let root = fixture.root(); let empty = manifest(&[]);
        let tree = Tree::begin(&root, 0, 0, &empty, 30_000).unwrap(); assert_eq!(tree.finish(&root).unwrap().files, 0);
    }
    #[test]
    fn event_baseline_actual_dirty_untracked_binary_empty_modes_leave_parent_unchanged() {
        let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("src")).unwrap();
        std::fs::write(fixture.0.join("src/dirty"), b"ordinary task latest\0\xff").unwrap();
        std::fs::set_permissions(fixture.0.join("src/dirty"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(fixture.0.join("src/new"), b"").unwrap(); std::fs::write(fixture.0.join("outside"), b"excluded").unwrap();
        std::fs::set_permissions(&fixture.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        let root = fixture.root(); let read = vec![PathRule { kind: "tree".into(), path: "src".into() }];
        let mut tree = ObservedTree::baseline(&root, read, vec![], 30_000).unwrap();
        let (names, complete) = tree.names_page(0).unwrap(); assert!(complete); assert_eq!(names, b"src/dirty\0src/new\0");
        let (dirty, executable) = tree.leaf(&root, "src/dirty").unwrap(); assert!(executable);
        assert_eq!(dirty.observed_sha256, sha(b"ordinary task latest\0\xff"));
        let (empty, executable) = tree.leaf(&root, "src/new").unwrap(); assert!(!executable); assert_eq!(empty.file_bytes, 0);
        let receipt = tree.finish(&root).unwrap(); assert_eq!(receipt.files, 2);
        assert_eq!(receipt.manifest_sha256, manifest(&[("src/dirty", b"ordinary task latest\0\xff", true), ("src/new", b"", false)]));
        assert_eq!(std::fs::read(fixture.0.join("outside")).unwrap(), b"excluded");
        assert_eq!(std::fs::metadata(&fixture.0).unwrap().permissions().mode() & 0o777, 0o755);
    }
    #[test]
    fn event_baseline_actual_inventory_changes_and_leaf_replacement_refuse() {
        for foreign in [false, true] {
            let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("src")).unwrap(); std::fs::write(fixture.0.join("src/file"), b"before").unwrap();
            let root = fixture.root(); let mut tree = ObservedTree::baseline(&root, vec![PathRule { kind: "tree".into(), path: "src".into() }], vec![], 30_000).unwrap();
            tree.leaf(&root, "src/file").unwrap();
            if foreign { std::fs::write(fixture.0.join("src/new"), b"new").unwrap(); }
            else { std::fs::write(fixture.0.join("src/file"), b"after!").unwrap(); }
            assert!(tree.finish(&root).is_err());
        }
    }
    #[test]
    fn event_baseline_actual_credential_symlink_hardlink_and_outside_leaf_refuse() {
        for kind in 0..3 {
            let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("src")).unwrap();
            let read = vec![PathRule { kind: "tree".into(), path: "src".into() }];
            if kind == 0 { std::fs::write(fixture.0.join("src/.env"), b"secret").unwrap(); }
            if kind == 1 { symlink(std::env::temp_dir(), fixture.0.join("src/escape")).unwrap(); }
            if kind == 2 { std::fs::write(fixture.0.join("outside"), b"private").unwrap(); std::fs::hard_link(fixture.0.join("outside"), fixture.0.join("src/alias")).unwrap(); }
            assert!(ObservedTree::baseline(&fixture.root(), read, vec![], 30_000).is_err());
        }
        let fixture = Fixture::new(); std::fs::write(fixture.0.join("outside"), b"outside").unwrap();
        let root = fixture.root(); let mut tree = ObservedTree::baseline(&root, vec![PathRule { kind: "tree".into(), path: "src".into() }], vec![], 30_000).unwrap();
        assert!(tree.leaf(&root, "outside").is_err()); assert_eq!(tree.finish(&root).unwrap().files, 0);
    }
    #[test]
    fn event_observer_actual_binary_empty_complete_namespace_and_drift() {
        let fixture = Fixture::new(); std::fs::write(fixture.0.join("binary"), vec![0xff; 65_537]).unwrap(); std::fs::write(fixture.0.join("empty"), []).unwrap();
        let root = fixture.root(); let mut tree = ObservedTree::begin(&root, 30_000).unwrap();
        assert_eq!(tree.leaf(&root, "binary").unwrap().0.file_bytes, 65_537); tree.leaf(&root, "empty").unwrap();
        assert_eq!(tree.finish(&root).unwrap().files, 2);
        let mut tree = ObservedTree::begin(&root, 30_000).unwrap(); tree.leaf(&root, "binary").unwrap();
        assert!(tree.finish(&root).is_err());
    }
}
