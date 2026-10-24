//! Windows browser binary custody beneath the original rooted helper. Work text
//! stages cannot create or adopt this object, and a path is never a stage lease.
use crate::{binary, native_windows::private_directory::{self, Descriptor}, no_follow::{self, LockedPath},
    protocol::{BrowserStageObservation, BrowserStagePurpose, Identity, WriteExpected, WriteObservation, WritePreparation}, root::Root,
    write::Failure, write_windows};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read, Seek, SeekFrom, Write}, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}, path::PathBuf, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{ReOpenFile, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE}, System::Threading::GetCurrentProcess};

const DELETE: u32 = 0x0001_0000;
const READ_CONTROL: u32 = 0x0002_0000;
pub struct Stage {
    base: LockedPath, project: LockedPath, directory: PathBuf, canonical: PathBuf,
    directory_file: Option<File>, identity: Identity, name: String, payload: Option<File>, anchor: Option<File>,
    purpose: BrowserStagePurpose, file_identity: Identity,
    offset: u64, limit: u64, stream: Sha256, sealed: bool, seal_stamp: Option<String>,
    prepared: bool, publication: Option<PathBuf>, unknown: bool, cleaned: bool,
}
// A failed constructor reduces only its original handles. If that reduction is
// unknown, this exact helper keeps custody; a path is never used to recover it.
struct Construction {
    base: Option<LockedPath>, project: Option<LockedPath>, directory: Option<File>, payload: Option<File>,
    anchor: Option<File>, purpose: BrowserStagePurpose,
}
impl Drop for Construction {
    fn drop(&mut self) {
        let Some(directory) = self.directory.as_ref() else { return; };
        let reduced = (|| -> io::Result<()> {
            if self.purpose == BrowserStagePurpose::Upload && self.payload.is_some() {
                if self.anchor.is_none() { self.anchor = Some(upload_anchor(self.payload.as_ref().unwrap())?); }
                reopen_upload_for_cleanup(&mut self.payload, self.anchor.as_ref().unwrap())?;
            }
            if let Some(payload) = self.payload.as_ref() { write_windows::dispose(payload)?; }
            drop(self.payload.take()); drop(self.anchor.take());
            if !write_windows::names(directory)?.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
            write_windows::dispose(directory)
        })();
        if reduced.is_err() { hold_unknown(); }
        drop(self.directory.take());
    }
}
// EOF, malformed input, output failure and Scope shutdown do not prove that
// Main cleared its FileList/network readers. Only exact native cleanup may drop
// this original stage. The original Native job owns final process termination.
impl Drop for Stage {
    fn drop(&mut self) { if !self.cleaned { hold_unknown(); } }
}
fn hold_unknown() -> ! { loop { std::thread::park(); } }

pub struct Prepared {
    id: String, relative: String, parent: LockedPath, parent_identity: Identity,
    stage_identity: Identity, sha256: String, bytes: u64, deadline: Instant,
}
impl Stage {
    pub fn create(root: &Root, basename: &str, name: &str, limit: u64, purpose: BrowserStagePurpose) -> io::Result<Self> {
        if limit > binary::LIMIT || basename.len() != 32 || !basename.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let parts = write_windows::components(name)?;
        if parts.len() != 1 { return Err(io::ErrorKind::InvalidInput.into()); }
        root.current()?;
        let project = LockedPath::open(&root.path, true, false)?;
        if no_follow::identity(&project.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        let parent = root.path.parent().ok_or(io::ErrorKind::PermissionDenied)?;
        let base = LockedPath::open(parent, true, false)?;
        write_windows::same_volume(&no_follow::identity(&base.file)?, &root.identity)?;
        let leaf = format!(".dac-browser-file-{basename}");
        let directory = parent.join(&leaf); let canonical = base.canonical().join(&leaf);
        if write_windows::overlaps(&canonical, project.canonical()) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let descriptor = Descriptor::current_user()?;
        let mut pending = Construction { base: Some(base), project: Some(project), directory: None, payload: None, anchor: None, purpose };
        pending.directory = Some(write_windows::open(&pending.base.as_ref().unwrap().file, &leaf, true,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE, 2, descriptor.pointer(), FILE_SHARE_READ)?);
        let directory_file = pending.directory.as_ref().unwrap();
        private_directory::require_private(directory_file)?;
        let identity = no_follow::identity(directory_file)?;
        if no_follow::final_path(directory_file)? != canonical { return Err(io::ErrorKind::PermissionDenied.into()); }
        // Chromium's network file reader does not share DELETE. Upload never
        // requests it; the original share-READ file object still denies writers
        // and deleters throughout FileList/network custody.
        pending.payload = Some(write_windows::open(directory_file, name, false,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | if purpose == BrowserStagePurpose::Download { DELETE } else { 0 },
            2, descriptor.pointer(), FILE_SHARE_READ)?);
        let payload = pending.payload.as_ref().unwrap();
        if purpose == BrowserStagePurpose::Upload { pending.anchor = Some(upload_anchor(payload)?); }
        private_directory::require_private(payload)?;
        let file_identity = no_follow::identity(payload)?;
        let mut value = Self { base: pending.base.take().unwrap(), project: pending.project.take().unwrap(), directory, canonical,
            directory_file: pending.directory.take(), identity, name: name.to_owned(),
            payload: pending.payload.take(), anchor: pending.anchor.take(), purpose, file_identity, offset: 0, limit, stream: Sha256::new(), sealed: false, seal_stamp: None,
            prepared: false, publication: None, unknown: false, cleaned: false };
        if let Err(error) = value.current(root) {
            // This constructor has never exposed a FileList or network reader.
            // Failed exact cleanup remains held by this original Stage's Drop.
            let path = value.directory.to_string_lossy().into_owned(); let identity = value.identity.clone();
            if value.cleanup(root, &path, &identity).is_err() { hold_unknown(); }
            return Err(error);
        }
        Ok(value)
    }
    fn payload(&self) -> io::Result<&File> { self.payload.as_ref().ok_or(io::ErrorKind::PermissionDenied.into()) }
    fn directory_file(&self) -> io::Result<&File> { self.directory_file.as_ref().ok_or(io::ErrorKind::PermissionDenied.into()) }
    fn current(&self, root: &Root) -> io::Result<()> {
        if self.cleaned || self.unknown { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.namespace_current(root)?;
        let payload = self.payload()?;
        private_directory::require_private(payload)?;
        if self.purpose == BrowserStagePurpose::Upload {
            let anchor = self.anchor.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
            private_directory::require_private(anchor)?;
            if no_follow::identity(anchor)? != self.file_identity || no_follow::final_path(anchor)? != self.canonical.join(&self.name) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
        let named = self.publication.as_ref().cloned().unwrap_or_else(|| self.canonical.join(&self.name));
        if no_follow::identity(payload)? != self.file_identity || no_follow::final_path(payload)? != named ||
            write_windows::accessible_links(payload)? != 1 || payload.metadata()?.len() != self.offset ||
            self.seal_stamp.as_ref().is_some_and(|stamp| no_follow::stamp(payload).map_or(true, |actual| &actual != stamp)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let names = write_windows::names(self.directory_file()?)?;
        if names != if self.publication.is_some() { Vec::new() } else { vec![self.name.clone()] } {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
    // Namespace authority remains the original held chain even while cleanup
    // is unknown; verify it again after the upload's post-join access transition.
    fn namespace_current(&self, root: &Root) -> io::Result<()> {
        root.current()?; self.base.current()?; self.project.current()?;
        if no_follow::identity(&self.project.file)? != root.identity || no_follow::identity(self.directory_file()?)? != self.identity ||
            no_follow::final_path(self.directory_file()?)? != self.canonical {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        private_directory::require_private(self.directory_file()?)
    }
    pub fn description(&self, root: &Root) -> io::Result<BrowserStageObservation> {
        self.current(root)?;
        Ok(BrowserStageObservation { version: 1, directory: self.directory.to_string_lossy().into_owned(),
            path: self.directory.join(&self.name).to_string_lossy().into_owned(), root: root.identity.clone(),
            stage: self.identity.clone(), file: self.file_identity.clone(), bytes: self.offset,
            sha256: format!("{:x}", self.stream.clone().finalize()), sealed: self.sealed })
    }
    pub fn write(&mut self, root: &Root, offset: u64, bytes: &[u8]) -> io::Result<()> {
        self.current(root)?;
        if self.sealed || offset != self.offset || bytes.is_empty() || bytes.len() as u64 > binary::BINARY_PAGE_LIMIT ||
            offset.checked_add(bytes.len() as u64).is_none_or(|total| total > self.limit) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // A partial OS write is never retried. The original stage remains unknown.
        self.unknown = true;
        self.payload.as_mut().ok_or(io::ErrorKind::PermissionDenied)?.write_all(bytes)?;
        self.offset += bytes.len() as u64; self.stream.update(bytes);
        self.unknown = false; self.current(root)
    }
    pub fn seal(&mut self, root: &Root, bytes: u64, sha256: &str, deadline_ms: u64) -> io::Result<()> {
        self.current(root)?;
        if self.sealed || self.offset != bytes || !digest(sha256) || deadline_ms == 0 || deadline_ms > 30_000 ||
            format!("{:x}", self.stream.clone().finalize()) != sha256 { return Err(io::ErrorKind::InvalidInput.into()); }
        self.payload()?.sync_all()?;
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        if observe(self.payload()?, deadline)? != (sha256.to_owned(), bytes) { return Err(io::ErrorKind::InvalidData.into()); }
        self.payload = Some(if self.purpose == BrowserStagePurpose::Upload { upload_read_handle(self.payload()?)? }
            else { write_windows::read_delete_handle(self.payload()?)? });
        self.seal_stamp = Some(no_follow::stamp(self.payload()?)?); self.sealed = true;
        self.current(root)
    }
    pub fn prepare(&mut self, root: &Root, id: &str, relative: &str, directory: &str, identity: &Identity,
        bytes: u64, sha256: &str, deadline_ms: u64) -> io::Result<Prepared> {
        self.current(root)?;
        if self.purpose != BrowserStagePurpose::Download || !self.sealed || self.prepared || self.name != "payload" || PathBuf::from(directory) != self.directory ||
            identity != &self.identity || bytes != self.offset || !digest(sha256) ||
            format!("{:x}", self.stream.clone().finalize()) != sha256 || deadline_ms == 0 || deadline_ms > 30_000 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.prepared = true;
        let parts = write_windows::components(relative)?;
        let parent = write_windows::parent(root, &parts)?;
        let parent_identity = no_follow::identity(&parent.file)?;
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        // Missing-only binary publication cannot replace even an existing empty file.
        write_windows::inspect_destination(root, relative, deadline_ms)?;
        if observe(self.payload()?, deadline)? != (sha256.to_owned(), bytes) { return Err(io::ErrorKind::InvalidData.into()); }
        self.current(root)?;
        Ok(Prepared { id: id.to_owned(), relative: relative.to_owned(), parent, parent_identity,
            stage_identity: self.identity.clone(), sha256: sha256.to_owned(), bytes, deadline })
    }
    pub fn cleanup(&mut self, root: &Root, directory: &str, identity: &Identity) -> io::Result<()> {
        self.current(root)?;
        if PathBuf::from(directory) != self.directory || identity != &self.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        // Native cleanup is reached only after Main has joined its FileList and
        // network readers. Never reopen by path: upload reduction uses the same
        // original metadata anchor after Main join. Delete-pending names remain
        // until the exact original payload/directory handles close.
        self.unknown = true;
        if self.purpose == BrowserStagePurpose::Upload {
            // Only Main's original FileList/network join reaches this reduction.
            // The metadata anchor is not a data lock. After dropping the data
            // guard, failures retain this original object/chain/slot as unknown.
            let anchor = self.anchor.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
            reopen_upload_for_cleanup(&mut self.payload, anchor)?;
            if observe(self.payload()?, Instant::now() + Duration::from_secs(10))? !=
                (format!("{:x}", self.stream.clone().finalize()), self.offset) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            self.namespace_current(root)?;
        }
        if self.publication.is_none() { write_windows::dispose(self.payload()?)?; }
        drop(self.payload.take()); drop(self.anchor.take());
        if !write_windows::names(self.directory_file()?)?.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        write_windows::dispose(self.directory_file()?)?;
        drop(self.directory_file.take());
        self.base.current()?; self.project.current()?; root.current()?;
        let name = self.directory.file_name().and_then(|name| name.to_str()).ok_or(io::ErrorKind::InvalidData)?;
        match write_windows::open(&self.base.file, name, true,
            windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES, 1, std::ptr::null(),
            FILE_SHARE_READ | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            _ => return Err(io::ErrorKind::PermissionDenied.into()),
        }
        self.cleaned = true; self.unknown = false;
        Ok(())
    }
}
impl Prepared {
    pub fn id(&self) -> &str { &self.id }
    pub fn description(&self) -> WritePreparation { WritePreparation { parent: self.parent_identity.clone(), stage: self.stage_identity.clone() } }
    pub fn publish(self, root: &Root, stage: &mut Stage) -> Result<WriteObservation, Failure> {
        let before = || -> io::Result<()> {
            stage.current(root)?; self.parent.current()?;
            if stage.identity != self.stage_identity || !stage.prepared || stage.publication.is_some() || Instant::now() >= self.deadline {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let parts = write_windows::components(&self.relative)?;
            if no_follow::identity(&write_windows::parent(root, &parts)?.file)? != self.parent_identity {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            write_windows::inspect_destination(root, &self.relative, self.deadline.saturating_duration_since(Instant::now()).as_millis().min(30_000) as u64)?;
            if observe(stage.payload()?, self.deadline)? != (self.sha256.clone(), self.bytes) { return Err(io::ErrorKind::InvalidData.into()); }
            Ok(())
        };
        before().map_err(|_| Failure::BeforePublish)?;
        let parts = write_windows::components(&self.relative).map_err(|_| Failure::BeforePublish)?;
        let leaf = parts.last().ok_or(Failure::BeforePublish)?;
        stage.unknown = true;
        write_windows::rename(stage.payload().map_err(|_| Failure::Unknown)?, &self.parent.file, leaf, false).map_err(|_| Failure::Unknown)?;
        // Renaming changes the stamp. The original read-only FileID still proves
        // the same object and the native lease still denies writers/deleters.
        stage.publication = Some(self.parent.canonical().join(leaf));
        stage.seal_stamp = Some(no_follow::stamp(stage.payload().map_err(|_| Failure::Unknown)?).map_err(|_| Failure::Unknown)?);
        stage.unknown = false;
        let after = || -> io::Result<()> {
            stage.current(root)?; self.parent.current()?;
            if observe(stage.payload()?, self.deadline)? != (self.sha256.clone(), self.bytes) { return Err(io::ErrorKind::InvalidData.into()); }
            Ok(())
        };
        if after().is_err() { stage.unknown = true; return Err(Failure::Unknown); }
        Ok(WriteObservation { parent: self.parent_identity, stage: self.stage_identity, file: stage.file_identity.clone(),
            sha256: self.sha256, bytes: self.bytes, previous: WriteExpected::Missing, publication: "optimistic_namespace_publish" })
    }
}
// ReOpenFile is anchored to the original kernel file object, never a path.
// Its broader sharing is metadata-only: the separate data guard remains READ
// sharing until the trusted Main join. Neither anchor nor sealed data can write.
fn upload_anchor(file: &File) -> io::Result<File> {
    let anchor = reopen(file, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)?;
    private_directory::require_private(&anchor)?;
    if no_follow::identity(&anchor)? != no_follow::identity(file)? || no_follow::final_path(&anchor)? != no_follow::final_path(file)? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(anchor)
}
fn reopen(file: &File, access: u32, sharing: u32) -> io::Result<File> {
    let handle = unsafe { ReOpenFile(file.as_raw_handle() as HANDLE, access, sharing, FILE_FLAG_OPEN_REPARSE_POINT) };
    if handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    if handle == 0 { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
}
fn upload_read_handle(file: &File) -> io::Result<File> {
    let process = unsafe { GetCurrentProcess() }; let mut handle = 0;
    if unsafe { DuplicateHandle(process, file.as_raw_handle() as HANDLE, process, &mut handle,
        FILE_GENERIC_READ, 0, 0) } == 0 { return Err(io::Error::last_os_error()); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    let reduced = File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
    if no_follow::identity(&reduced)? != no_follow::identity(file)? { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(reduced)
}
fn reopen_upload_for_cleanup(payload: &mut Option<File>, anchor: &File) -> io::Result<()> {
    let original = payload.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
    let identity = no_follow::identity(original)?; let named = no_follow::final_path(original)?;
    let stamp = no_follow::stamp(original)?; let bytes = original.metadata()?.len();
    private_directory::require_private(original)?; private_directory::require_private(anchor)?;
    if no_follow::identity(anchor)? != identity || no_follow::final_path(anchor)? != named ||
        write_windows::accessible_links(original)? != 1 || write_windows::accessible_links(anchor)? != 1 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    drop(payload.take());
    *payload = Some(reopen(anchor, FILE_GENERIC_READ | DELETE, FILE_SHARE_READ)?);
    let reduced = payload.as_ref().unwrap();
    private_directory::require_private(reduced)?;
    if no_follow::identity(reduced)? != identity || no_follow::final_path(reduced)? != named ||
        no_follow::stamp(reduced)? != stamp || reduced.metadata()?.len() != bytes || write_windows::accessible_links(reduced)? != 1 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}
fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) }
fn observe(file: &File, deadline: Instant) -> io::Result<(String, u64)> {
    let before = no_follow::stamp(file)?; let bytes = file.metadata()?.len();
    if bytes > binary::LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
    let mut reader = file.try_clone()?; reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new(); let mut buffer = [0; 65_536]; let mut total = 0u64;
    loop {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        let read = reader.read(&mut buffer)?; if read == 0 { break; }
        total = total.checked_add(read as u64).ok_or(io::ErrorKind::InvalidData)?;
        if total > binary::LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
        hash.update(&buffer[..read]);
    }
    if bytes != total || no_follow::stamp(file)? != before { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok((format!("{:x}", hash.finalize()), total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};
    fn owned() -> PathBuf {
        let path = std::env::temp_dir().join(format!("dac-browser-native-stage-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&path).unwrap(); fs::create_dir(path.join("project")).unwrap(); path
    }
    #[test]
    fn original_binary_stage_seals_and_keeps_windows_locks_through_read_and_cleanup() {
        let directory = owned();
        {
            let root = Root::inspect(directory.join("project").to_str().unwrap()).unwrap();
            let canonical = no_follow::final_path(&root.file).unwrap();
            assert_eq!(Root::inspect(canonical.to_str().unwrap()).unwrap().identity, root.identity);
            assert_eq!(LockedPath::open(&canonical, true, false).unwrap().canonical(), &canonical);
            assert!(Root::inspect("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume4\\").is_err());
            let junction = directory.join("linked-project");
            let created = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"])
                .arg(&junction).arg(&root.path).output().unwrap();
            assert!(created.status.success());
            assert!(Root::inspect(junction.to_str().unwrap()).is_err());
            assert!(LockedPath::open(&junction, true, false).is_err());
            fs::remove_dir(&junction).unwrap();

            // Exercise the constructor's original-handle reduction with only a
            // directory captured, then with both captured namespace objects.
            for (leaf, purpose) in [("partial-directory", BrowserStagePurpose::Download), ("partial-payload", BrowserStagePurpose::Download),
                ("partial-upload-directory", BrowserStagePurpose::Upload), ("partial-upload-payload", BrowserStagePurpose::Upload)] {
                let base = LockedPath::open(&directory, true, false).unwrap();
                let project = LockedPath::open(&root.path, true, false).unwrap();
                let descriptor = Descriptor::current_user().unwrap();
                let dir = write_windows::open(&base.file, leaf, true, FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
                    2, descriptor.pointer(), FILE_SHARE_READ).unwrap();
                let payload = if leaf.ends_with("payload") { Some(write_windows::open(&dir, "payload", false,
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE | if purpose == BrowserStagePurpose::Download { DELETE } else { 0 },
                    2, descriptor.pointer(), FILE_SHARE_READ).unwrap()) } else { None };
                drop(Construction { base: Some(base), project: Some(project), directory: Some(dir), payload, anchor: None, purpose });
                assert!(!directory.join(leaf).exists());
            }
            let mut stage = Stage::create(&root, "11111111111111111111111111111111", "approved.bin", 50, BrowserStagePurpose::Upload).unwrap();
            let bytes = b"binary\0\xff\nowned Windows payload";
            stage.write(&root, 0, &bytes[..8]).unwrap(); stage.write(&root, 8, &bytes[8..]).unwrap();
            assert!(stage.write(&root, 0, b"replayed").is_err());
            stage.seal(&root, bytes.len() as u64, &format!("{:x}", Sha256::digest(bytes)), 10_000).unwrap();
            let fact = stage.description(&root).unwrap();
            assert!(fact.sealed); assert_eq!(fact.bytes, bytes.len() as u64);
            assert_eq!(fs::read(&fact.path).unwrap(), bytes);
            // Exact Chromium 146 UploadFileElementReader open; std::fs::read's
            // default SHARE_DELETE would hide the original incompatibility.
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::{Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING}, System::IO::{GetOverlappedResult, OVERLAPPED}};
            let named = PathBuf::from(&fact.path).as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            let opened = unsafe { CreateFileW(named.as_ptr(), 0x8000_0000, FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, 0) };
            assert_ne!(opened, INVALID_HANDLE_VALUE, "{:?}", io::Error::last_os_error());
            let chromium = File::from(unsafe { OwnedHandle::from_raw_handle(opened as RawHandle) });
            assert_eq!(no_follow::identity(&chromium).unwrap(), fact.file);
            let mut actual = vec![0; bytes.len()]; let mut length = 0; let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            let read = unsafe { windows_sys::Win32::Storage::FileSystem::ReadFile(opened, actual.as_mut_ptr(), actual.len() as u32, &mut length, &mut overlapped) };
            if read == 0 { assert_eq!(io::Error::last_os_error().raw_os_error(), Some(997)); }
            assert_ne!(unsafe { GetOverlappedResult(opened, &overlapped, &mut length, 1) }, 0);
            assert_eq!(length as usize, bytes.len()); assert_eq!(actual, bytes);
            drop(chromium); // Main's network join is represented by this close.
            assert_eq!(no_follow::identity(stage.anchor.as_ref().unwrap()).unwrap(), fact.file);
            assert!(stage.payload.as_mut().unwrap().write_all(b"forbidden").is_err());
            assert!(fs::OpenOptions::new().write(true).open(&fact.path).is_err());
            assert!(fs::rename(&fact.path, directory.join("moved.bin")).is_err());
            assert!(stage.write(&root, bytes.len() as u64, b"extra").is_err());
            assert!(stage.cleanup(&root, &fact.directory, &root.identity).is_err());
            assert!(!stage.unknown); assert!(stage.payload.is_some());
            assert!(fs::OpenOptions::new().write(true).open(&fact.path).is_err());
            assert!(fs::rename(&fact.path, directory.join("wrong-cleanup-move.bin")).is_err());
            assert!(stage.prepare(&root, "upload-cannot-publish", "no.bin", &fact.directory, &fact.stage,
                fact.bytes, &fact.sha256, 10_000).is_err());
            stage.cleanup(&root, &fact.directory, &fact.stage).unwrap();
            assert!(!PathBuf::from(&fact.path).exists()); assert!(!PathBuf::from(&fact.directory).exists());
            assert!(stage.description(&root).is_err());
        }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn original_binary_stage_publishes_missing_only_and_retains_existing_destination() {
        let directory = owned();
        {
            let project = directory.join("project");
            let root = Root::inspect(project.to_str().unwrap()).unwrap();
            let bytes = b"download\0\xffnative"; let sha = format!("{:x}", Sha256::digest(bytes));
            let mut stage = Stage::create(&root, "22222222222222222222222222222222", "payload", 50, BrowserStagePurpose::Download).unwrap();
            stage.write(&root, 0, bytes).unwrap(); stage.seal(&root, bytes.len() as u64, &sha, 10_000).unwrap();
            let fact = stage.description(&root).unwrap();
            let prepared = stage.prepare(&root, "download-1", "download.bin", &fact.directory, &fact.stage,
                bytes.len() as u64, &sha, 10_000).unwrap();
            let observed = prepared.publish(&root, &mut stage).map_err(|_| ()).unwrap();
            assert_eq!(observed.file, fact.file); assert_eq!(observed.sha256, sha);
            assert_eq!(fs::read(project.join("download.bin")).unwrap(), bytes);
            stage.cleanup(&root, &fact.directory, &fact.stage).unwrap();
            assert_eq!(fs::read(project.join("download.bin")).unwrap(), bytes);
            let mut next = Stage::create(&root, "33333333333333333333333333333333", "payload", 50, BrowserStagePurpose::Download).unwrap();
            next.write(&root, 0, b"other").unwrap(); next.seal(&root, 5, &format!("{:x}", Sha256::digest(b"other")), 10_000).unwrap();
            let other = next.description(&root).unwrap();
            assert!(next.prepare(&root, "download-2", "download.bin", &other.directory, &other.stage,
                5, &other.sha256, 10_000).is_err());
            assert_eq!(fs::read(project.join("download.bin")).unwrap(), bytes);
            next.cleanup(&root, &other.directory, &other.stage).unwrap();
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
