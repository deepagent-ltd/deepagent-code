//! Private known-artifact collection, retaining the original immutable Git registration.
//! It follows no links and never removes the parent project's files or shared Git objects.
use crate::{event_worktree::{ObservedTree, BYTES, DIRECTORIES, FILES}, no_follow, root::Root};
use std::{fs::File, io, time::{Duration, Instant}};

pub enum Failure { BeforeMutation, Unknown }
#[cfg(windows)]
#[path = "event_cleanup_windows.rs"]
mod windows;

#[cfg(unix)]
pub fn clear(root: &Root, files: u64, bytes: u64, manifest: &str, deadline_ms: u64) -> Result<u64, Failure> {
    use rustix::fs::{AtFlags, unlinkat};
    use std::os::unix::fs::MetadataExt;
    let changed = std::cell::Cell::new(false);
    let result = (|| -> io::Result<u64> {
        if files > FILES || bytes > BYTES || deadline_ms == 0 || deadline_ms > 180_000 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        root.current()?;
        let metadata = root.file.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        let (names, directories) = inventory(root, deadline)?;
        let directories = directories.into_iter().map(|name| directory(root, &no_follow::relative(&name)?).and_then(|file|
            no_follow::identity(&file).map(|identity| (name, identity)))).collect::<io::Result<Vec<_>>>()?;
        let mut observed = ObservedTree::begin(root, deadline_ms)?;
        for name in &names { observed.leaf(root, name)?; }
        let stamps = observed.observed_stamps();
        let receipt = observed.finish(root)?;
        if receipt.files != files || receipt.bytes != bytes || receipt.manifest_sha256 != manifest { return Err(io::ErrorKind::InvalidData.into()); }
        for (name, expected_stamp) in stamps {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            root.current()?;
            let parts = no_follow::relative(&name)?;
            let parent = directory(root, &parts[..parts.len()-1])?;
            let file = no_follow::open_relative(&root.file, &parts)?;
            let stamp = no_follow::stamp(&file)?;
            if stamp != expected_stamp || no_follow::stamp(&no_follow::open_relative(&root.file, &parts)?)? != stamp { return Err(io::ErrorKind::InvalidData.into()); }
            unlinkat(&parent, *parts.last().ok_or(io::ErrorKind::InvalidInput)?, AtFlags::empty())?; changed.set(true);
            parent.sync_all()?;
            if file.metadata()?.nlink() != 0 { return Err(io::ErrorKind::InvalidData.into()); }
            absent(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?)?;
        }
        for (name, expected_identity) in directories.iter().rev() {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            root.current()?;
            let parts = no_follow::relative(name)?;
            let parent = directory(root, &parts[..parts.len()-1])?;
            let held = directory(root, &parts)?;
            if &no_follow::identity(&held)? != expected_identity || no_follow::identity(&held)? != no_follow::identity(&directory(root, &parts)?)? { return Err(io::ErrorKind::InvalidData.into()); }
            unlinkat(&parent, *parts.last().ok_or(io::ErrorKind::InvalidInput)?, AtFlags::REMOVEDIR)?; changed.set(true);
            parent.sync_all()?;
            unlinked_directory(&held)?;
            absent(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?)?;
        }
        empty(root, deadline)?;
        let empty = ObservedTree::begin(root, deadline_ms)?.finish(root)?;
        root.current()?; Ok(empty.allocated_bytes)
    })();
    result.map_err(|_| if changed.get() { Failure::Unknown } else { Failure::BeforeMutation })
}

#[cfg(windows)]
pub fn clear(root: &Root, files: u64, bytes: u64, manifest: &str, deadline_ms: u64) -> Result<u64, Failure> { windows::clear(root, files, bytes, manifest, deadline_ms) }

#[cfg(unix)]
fn absent(parent: &File, name: &str) -> io::Result<()> {
    match rustix::fs::statat(parent, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(io::ErrorKind::InvalidData.into()),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unlinked_directory(file: &File) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    if file.metadata()?.nlink() != 0 { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn unlinked_directory(file: &File) -> io::Result<()> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    unsafe extern "C" { fn fsgetpath(buffer: *mut libc::c_char, size: usize, fsid: *mut libc::fsid_t, object: u64) -> libc::ssize_t; }
    // APFS retains a removed held directory's st_nlink. Resolve its inode in the actual
    // mounted filesystem instead; a renamed still-linked inode must remain Unknown.
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error()); }
    let mut filesystem = unsafe { filesystem.assume_init() };
    let mut buffer = [0; libc::PATH_MAX as usize];
    if unsafe { fsgetpath(buffer.as_mut_ptr(), buffer.len(), &mut filesystem.f_fsid, file.metadata()?.ino()) } >= 0 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ENOENT) { return Err(error); }
    Ok(())
}

#[cfg(unix)]
fn empty(root: &Root, deadline: Instant) -> io::Result<()> {
    let (files, directories) = inventory(root, deadline)?;
    if !files.is_empty() || !directories.is_empty() { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(())
}

#[cfg(unix)]
fn directory(root: &Root, parts: &[&str]) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, openat};
    use std::os::unix::fs::MetadataExt;
    let mut file = File::from(openat(&root.file, ".", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
    if no_follow::identity(&file)? != root.identity { return Err(io::ErrorKind::InvalidData.into()); }
    for part in parts {
        file = File::from(openat(&file, *part, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
        let metadata = file.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    Ok(file)
}

#[cfg(unix)]
fn inventory(root: &Root, deadline: Instant) -> io::Result<(Vec<String>, Vec<String>)> {
    use rustix::fs::{Dir, Mode, OFlags, openat};
    use std::os::unix::fs::MetadataExt;
    let mut pending = vec![(String::new(), directory(root, &[])?)];
    let mut names = Vec::new(); let mut directories = Vec::new();
    while let Some((prefix, parent)) = pending.pop() {
        root.current()?;
        for entry in Dir::read_from(&parent)? {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            let entry = entry?; let name = entry.file_name().to_str().map_err(|_| io::ErrorKind::InvalidData)?;
            if name == "." || name == ".." { continue; }
            let relative = if prefix.is_empty() { name.to_owned() } else { format!("{prefix}/{name}") };
            let file = File::from(openat(&parent, name, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?);
            let metadata = file.metadata()?;
            if prefix.is_empty() && name == ".git" && metadata.is_file() && metadata.nlink() == 1 { continue; }
            if relative.len() > 2048 || no_follow::relative(&relative)?.len() > 32 || metadata.uid() != unsafe { libc::geteuid() } ||
                metadata.mode() & 0o077 != 0 || name.starts_with(".dac-tree-") { return Err(io::ErrorKind::InvalidData.into()); }
            if metadata.is_dir() {
                directories.push(relative.clone()); pending.push((relative, file));
            } else if metadata.is_file() && metadata.nlink() == 1 { names.push(relative); }
            else { return Err(io::ErrorKind::InvalidData.into()); }
            if names.len() > FILES as usize || directories.len() > DIRECTORIES { return Err(io::ErrorKind::InvalidData.into()); }
        }
    }
    names.sort(); directories.sort_by(|left, right| left.split('/').count().cmp(&right.split('/').count()).then(left.cmp(right)));
    root.current()?; Ok((names, directories))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::{PermissionsExt, symlink}, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("dac-event-gc-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap(); std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap(); Self(path)
        }
        fn root(&self) -> Root { Root::inspect(self.0.to_str().unwrap()).unwrap() }
        fn leaf(&self, name: &str, bytes: &[u8]) {
            std::fs::write(self.0.join(name), bytes).unwrap(); std::fs::set_permissions(self.0.join(name), std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn manifest(values: &[(&str, &[u8])]) -> String {
        let mut hash = Sha256::new();
        for (name, bytes) in values {
            hash.update((name.len() as u32).to_be_bytes()); hash.update(name.as_bytes()); hash.update((bytes.len() as u64).to_be_bytes());
            hash.update(format!("{:x}", Sha256::digest(bytes)).as_bytes()); hash.update([0]);
        }
        format!("{:x}", hash.finalize())
    }
    #[test]
    fn event_gc_actual_known_files_only_retains_git_identity_and_original_parent() {
        let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("src")).unwrap();
        std::fs::set_permissions(fixture.0.join("src"), std::fs::Permissions::from_mode(0o700)).unwrap();
        fixture.leaf(".git", b"gitdir: original immutable registration\n"); fixture.leaf("src/binary", b"\0\xff\x80"); fixture.leaf("src/empty", b"");
        let root = fixture.root(); let identity = root.identity.clone();
        let retained = clear(&root, 2, 3, &manifest(&[("src/binary", b"\0\xff\x80"), ("src/empty", b"")]), 30_000).ok().unwrap();
        assert!(retained > 0); assert_eq!(root.identity, identity); root.current().unwrap();
        assert_eq!(std::fs::read(fixture.0.join(".git")).unwrap(), b"gitdir: original immutable registration\n");
        assert!(!fixture.0.join("src").exists());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
    #[test]
    fn event_gc_actual_wrong_manifest_foreign_hardlink_and_symlink_never_mutate() {
        let fixture = Fixture::new(); fixture.leaf("file", b"original");
        assert!(matches!(clear(&fixture.root(), 1, 8, &manifest(&[("file", b"modified")]), 30_000), Err(Failure::BeforeMutation)));
        assert_eq!(std::fs::read(fixture.0.join("file")).unwrap(), b"original");
        std::fs::hard_link(fixture.0.join("file"), fixture.0.join("alias")).unwrap();
        assert!(matches!(clear(&fixture.root(), 1, 8, &manifest(&[("file", b"original")]), 30_000), Err(Failure::BeforeMutation)));
        std::fs::remove_file(fixture.0.join("alias")).unwrap(); symlink(std::env::temp_dir(), fixture.0.join("link")).unwrap();
        assert!(matches!(clear(&fixture.root(), 1, 8, &manifest(&[("file", b"original")]), 30_000), Err(Failure::BeforeMutation)));
        assert_eq!(std::fs::read(fixture.0.join("file")).unwrap(), b"original");
    }
    #[test]
    fn event_gc_actual_empty_directory_and_named_symlink_are_not_absence() {
        let fixture = Fixture::new(); fixture.leaf(".git", b"original immutable registration");
        let root = fixture.root();
        empty(&root, Instant::now() + Duration::from_secs(1)).unwrap();
        std::fs::create_dir(fixture.0.join("foreign")).unwrap();
        std::fs::set_permissions(fixture.0.join("foreign"), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(empty(&root, Instant::now() + Duration::from_secs(1)).is_err());
        assert!(absent(&root.file, "foreign").is_err());
        std::fs::remove_dir(fixture.0.join("foreign")).unwrap();
        absent(&root.file, "foreign").unwrap();
        symlink(fixture.0.join("missing"), fixture.0.join("foreign")).unwrap();
        assert!(absent(&root.file, "foreign").is_err());
    }
    #[test]
    fn event_gc_actual_renamed_held_directory_never_proves_removal() {
        let fixture = Fixture::new(); std::fs::create_dir(fixture.0.join("held")).unwrap();
        std::fs::set_permissions(fixture.0.join("held"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = fixture.root(); let held = directory(&root, &["held"]).unwrap();
        assert!(unlinked_directory(&held).is_err());
        std::fs::rename(fixture.0.join("held"), fixture.0.join("renamed")).unwrap();
        absent(&root.file, "held").unwrap();
        assert!(unlinked_directory(&held).is_err());
        std::fs::remove_dir(fixture.0.join("renamed")).unwrap();
        unlinked_directory(&held).unwrap();
    }
}
