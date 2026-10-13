//! Work publication owns a distinct, single original stage. Private settings
//! leases and command AppContainer leases cannot authorize these operations.
use crate::{no_follow::{self, LockedPath}, native_windows::private_directory::{self, Descriptor},
    protocol::{Identity, WriteExpected, WriteObservation, WritePreparation, WriteStageFile, WriteStageObservation, PAGE_LIMIT, SCAN_LIMIT},
    root::Root, write::Failure};
use sha2::{Digest, Sha256};
use std::{ffi::{c_void, OsStr}, fs::File, io::{self, Read, Seek, SeekFrom, Write},
    mem::{offset_of, size_of}, os::windows::{ffi::{OsStrExt, OsStringExt},
    io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}}, path::{Path, PathBuf}, ptr,
    sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING},
    Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE, FILE_RENAME_INFO, FILE_RENAME_INFO_0, FILE_ID_BOTH_DIR_INFO,
        FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx},
    System::{IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0}, Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE},
        Threading::GetCurrentProcess}};

const DELETE: u32 = 0x0001_0000;
// The helper has one write admission; the original handles are never rebuilt
// from a stage path, FileID or historical record in another process.
static STAGE: Mutex<Option<Stage>> = Mutex::new(None);
static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

struct Held { file: File, identity: Identity, hash: String, bytes: u64 }
struct Stage {
    data: LockedPath, base: LockedPath, project: LockedPath, root: Option<LockedPath>,
    directory: PathBuf, basename: String, identity: Identity, payload: Option<Held>, previous: Option<Held>,
    published: Option<Held>, prepared: bool, attempted: bool, unknown: bool, cleaned: bool,
}

pub fn prepare_stage(root: &Root, data: &str, basename: &str) -> io::Result<WriteStageObservation> {
    let mut state = STAGE.lock().map_err(|_| io::ErrorKind::Other)?;
    if state.is_some() || basename.len() != 32 || !basename.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) ||
        Path::new(data) != fixed_data_root()? { return Err(io::ErrorKind::PermissionDenied.into()); }
    root.current()?;
    let data = LockedPath::open(Path::new(data), true, false)?;
    let project = LockedPath::open(&root.path, true, false)?;
    if no_follow::identity(&project.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    let base_path = fixed_data_root()?.join("work-write-stage");
    let base = match LockedPath::open(&base_path, true, false) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let descriptor = Descriptor::current_user()?;
            let created = no_follow::create_private_child(&data.file, "work-write-stage", true, descriptor.pointer())?;
            private_directory::require_private(&created)?;
            let identity = no_follow::identity(&created)?; drop(created);
            let value = LockedPath::open(&base_path, true, false)?;
            if no_follow::identity(&value.file)? != identity { return Err(io::ErrorKind::PermissionDenied.into()); }
            value
        },
        Err(error) => return Err(error),
    };
    data.current()?; base.current()?; project.current()?;
    private_directory::require_private(&base.file)?;
    same_volume(&no_follow::identity(&base.file)?, &root.identity)?;
    let directory = base_path.join(basename);
    let physical = base.canonical().join(basename);
    if overlaps(&physical, project.canonical()) { return Err(io::ErrorKind::PermissionDenied.into()); }
    let descriptor = Descriptor::current_user()?;
    let created = no_follow::create_private_child(&base.file, basename, true, descriptor.pointer())?;
    private_directory::require_private(&created)?;
    let identity = no_follow::identity(&created)?; drop(created);
    let owned = LockedPath::open(&directory, true, false)?;
    if no_follow::identity(&owned.file)? != identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    // Capture before the last validation: a partially created original stage is
    // retained if its current check fails; it cannot silently become a new slot.
    *state = Some(Stage { data, base, project, root: Some(owned), directory, basename: basename.to_owned(),
        identity, payload: None, previous: None, published: None, prepared: false, attempted: false, unknown: false, cleaned: false });
    let stage = state.as_ref().ok_or(io::ErrorKind::Other)?;
    stage.observe(root)
}

pub fn inspect_stage(root: &Root) -> io::Result<WriteStageObservation> {
    STAGE.lock().map_err(|_| io::ErrorKind::Other)?.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.observe(root)
}

pub struct Prepared {
    id: String, relative: String, parent: LockedPath, parent_identity: Identity,
    stage_identity: Identity, expected: WriteExpected, hash: String, bytes: u64, deadline: Instant,
}

impl Prepared {
    pub fn prepare(root: &Root, id: &str, relative: &str, directory: &str, identity: &Identity,
        content: &str, expected: &WriteExpected, deadline_ms: u64) -> io::Result<Self> {
        if content.len() as u64 > PAGE_LIMIT || deadline_ms == 0 || deadline_ms > 30_000 { return Err(io::ErrorKind::InvalidInput.into()); }
        if let WriteExpected::Observed { identity, sha256, bytes } = expected {
            if !matches!(identity, Identity::Windows { .. }) || *bytes > SCAN_LIMIT || !digest(sha256) {
                return Err(io::ErrorKind::InvalidInput.into());
            }
        }
        let mut state = STAGE.lock().map_err(|_| io::ErrorKind::Other)?;
        let stage = state.as_mut().ok_or(io::ErrorKind::PermissionDenied)?;
        stage.current(root)?;
        if stage.attempted || Path::new(directory) != stage.directory || identity != &stage.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        stage.attempted = true;
        let parts = components(relative)?;
        let parent = parent(root, &parts)?;
        let parent_identity = no_follow::identity(&parent.file)?;
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        stage.previous = expected_file(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, expected, deadline)?;
        let descriptor = Descriptor::current_user()?;
        let file = open(&stage.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.file, "payload", false,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE, 2, descriptor.pointer(), FILE_SHARE_READ)?;
        private_directory::require_private(&file)?;
        let payload_identity = no_follow::identity(&file)?;
        stage.payload = Some(Held { file, identity: payload_identity, hash: String::new(), bytes: 0 });
        let payload = stage.payload.as_mut().ok_or(io::ErrorKind::Other)?;
        payload.file.write_all(content.as_bytes())?; payload.file.sync_all()?;
        payload.hash = format!("{:x}", Sha256::digest(content.as_bytes())); payload.bytes = content.len() as u64;
        // Reduce access on the original file object without opening a sharing
        // window. The published handle cannot write; its deny-WRITE/DELETE
        // reservation remains held through the known publication boundary.
        payload.file = read_delete_handle(&payload.file)?;
        stage.current(root)?;
        parent.current()?;
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        stage.prepared = true;
        Ok(Self { id: id.to_owned(), relative: relative.to_owned(), parent, parent_identity, stage_identity: identity.clone(),
            expected: expected.clone(), hash: format!("{:x}", Sha256::digest(content.as_bytes())), bytes: content.len() as u64, deadline })
    }

    // Browser binary publication needs its own original stage/capture producer;
    // ordinary Work text grants cannot authorize a reconstructed binary stage.
    pub fn prepare_binary(_: &Root, _: &str, _: &str, _: &str, _: &Identity, _: u64, _: &str, _: u64) -> io::Result<Self> {
        Err(io::ErrorKind::Unsupported.into())
    }
    pub fn id(&self) -> &str { &self.id }
    pub fn description(&self) -> WritePreparation { WritePreparation { parent: self.parent_identity.clone(), stage: self.stage_identity.clone() } }

    pub fn publish(self, root: &Root) -> Result<WriteObservation, Failure> {
        let mut state = STAGE.lock().map_err(|_| Failure::BeforePublish)?;
        let stage = state.as_mut().ok_or(Failure::BeforePublish)?;
        let before = || -> io::Result<()> {
            stage.current(root)?; self.parent.current()?;
            if !stage.prepared || stage.unknown || stage.published.is_some() || stage.identity != self.stage_identity || Instant::now() >= self.deadline {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let parts = components(&self.relative)?;
            let current = parent(root, &parts)?;
            if no_follow::identity(&current.file)? != self.parent_identity { return Err(io::ErrorKind::PermissionDenied.into()); }
            let named = expected_file(&self.parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, &self.expected, self.deadline)?;
            if named.as_ref().map(|value| &value.identity) != stage.previous.as_ref().map(|value| &value.identity) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let payload = stage.payload.as_ref().ok_or(io::ErrorKind::InvalidData)?;
            named_file(&payload.file, stage.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.canonical(), "payload")?;
            if accessible_links(&payload.file)? != 1 || observe(&payload.file, self.deadline)? != (self.hash.clone(), self.bytes) { return Err(io::ErrorKind::InvalidData.into()); }
            Ok(())
        };
        before().map_err(|error| { diagnose("before", &error); Failure::BeforePublish })?;
        let leaf = components(&self.relative).map_err(|_| Failure::BeforePublish)?.last().ok_or(Failure::BeforePublish)?.to_string();
        // Windows replacement leaves the old object accessible by its original
        // handle (FILE_RENAME_POSIX_SEMANTICS); it is not RENAME_EXCHANGE.
        // Retain both handles before the sole namespace syscall. Any later
        // failure stays unknown, including an OS error with no visible effect.
        stage.unknown = true;
        let payload = stage.payload.as_ref().ok_or(Failure::Unknown)?;
        rename(&payload.file, &self.parent.file, &leaf, matches!(self.expected, WriteExpected::Observed { .. }))
            .map_err(|error| { diagnose("rename", &error); Failure::Unknown })?;
        let after = || -> io::Result<WriteObservation> {
            stage.current(root)?; self.parent.current()?;
            let payload = stage.payload.as_ref().ok_or(io::ErrorKind::InvalidData)?;
            named_file(&payload.file, self.parent.canonical(), &leaf)?;
            let opened = open(&self.parent.file, &leaf, false, FILE_GENERIC_READ, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)?;
            if accessible_links(&opened)? != 1 || no_follow::identity(&opened)? != payload.identity || observe(&opened, self.deadline)? != (self.hash.clone(), self.bytes) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            if let Some(previous) = &stage.previous {
                if accessible_links(&previous.file)? != 0 || observe(&previous.file, self.deadline)? != (previous.hash.clone(), previous.bytes) {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
            }
            if !names(&stage.reader()?)?.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
            Ok(WriteObservation { parent: self.parent_identity.clone(), stage: stage.identity.clone(), file: payload.identity.clone(),
                sha256: self.hash.clone(), bytes: self.bytes, previous: self.expected.clone(), publication: "optimistic_namespace_publish" })
        };
        let observed = after().map_err(|error| { diagnose("after", &error); Failure::Unknown })?;
        stage.published = stage.payload.take(); stage.unknown = false;
        Ok(observed)
    }
}

fn diagnose(stage: &'static str, error: &io::Error) {
    eprintln!("DAC_WINDOWS_WORK_WRITE stage={stage} kind={:?} os={}", error.kind(), error.raw_os_error().unwrap_or(0));
}

impl Stage {
    fn current(&self, root: &Root) -> io::Result<()> {
        if self.cleaned || fixed_data_root()? != self.directory.parent().and_then(Path::parent).ok_or(io::ErrorKind::InvalidInput)? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        root.current()?; self.data.current()?; self.base.current()?; self.project.current()?;
        if no_follow::identity(&self.project.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        private_directory::require_private(&self.base.file)?;
        let stage = self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        stage.current()?; private_directory::require_private(&stage.file)?;
        if no_follow::identity(&stage.file)? != self.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        same_volume(&self.identity, &root.identity)
    }
    fn reader(&self) -> io::Result<File> {
        let file = open(&self.base.file, &self.basename, true, FILE_GENERIC_READ, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE)?;
        if no_follow::identity(&file)? != self.identity || no_follow::final_path(&file)? != self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.canonical() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(file)
    }
    fn observe(&self, root: &Root) -> io::Result<WriteStageObservation> {
        self.current(root)?;
        let reader = self.reader()?;
        let entries = names(&reader)?;
        if entries.iter().any(|name| name != "payload") || entries.len() > 1 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut files = Vec::new();
        if let Some(payload) = &self.payload {
            let in_stage = no_follow::final_path(&payload.file)? == self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.canonical().join("payload");
            if in_stage != entries.contains(&"payload".to_owned()) { return Err(io::ErrorKind::PermissionDenied.into()); }
            if in_stage { files.push(fact(payload, "payload", false, deadline)?); }
        } else if !entries.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        if let Some(previous) = &self.previous {
            // Prior to publication the old object is still in the project; it
            // becomes stage-retained capacity only after the original unlink.
            if accessible_links(&previous.file)? == 0 { files.push(fact(previous, "previous", true, deadline)?); }
        }
        self.current(root)?;
        if names(&reader)? != entries { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(WriteStageObservation { version: 1, directory: self.directory.to_string_lossy().into_owned(),
            data: no_follow::identity(&self.data.file)?, base: no_follow::identity(&self.base.file)?, stage: self.identity.clone(), root: root.identity.clone(),
            retained_bytes: files.iter().map(|value| value.bytes).sum(), files })
    }
}

pub fn cleanup(root: &Root, directory: &str, identity: &Identity) -> io::Result<()> {
    let mut state = STAGE.lock().map_err(|_| io::ErrorKind::Other)?;
    let stage = state.as_mut().ok_or(io::ErrorKind::PermissionDenied)?;
    stage.current(root)?;
    if stage.unknown || Path::new(directory) != stage.directory || identity != &stage.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    let observed = stage.observe(root)?;
    // No foreign name can be removed. The payload was created exclusively by
    // this original stage and remains held deny-WRITE/DELETE until this point.
    stage.unknown = true;
    if let Some(payload) = &stage.payload {
        let expected = observed.files.iter().find(|file| file.relative == "payload").ok_or(io::ErrorKind::InvalidData)?;
        if payload.identity != expected.identity || observe(&payload.file, Instant::now() + Duration::from_secs(10))? != (expected.sha256.clone(), expected.bytes) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        dispose(&payload.file)?;
    }
    drop(stage.payload.take());
    if let Some(previous) = &stage.previous {
        if stage.published.is_some() && accessible_links(&previous.file)? != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    drop(stage.previous.take()); drop(stage.published.take());
    if !names(&stage.reader()?)?.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let canonical = stage.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.canonical().to_owned();
    drop(stage.root.take());
    let removed = open(&stage.base.file, &stage.basename, true, FILE_GENERIC_READ | DELETE, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE)?;
    private_directory::require_private(&removed)?;
    if no_follow::identity(&removed)? != stage.identity || no_follow::final_path(&removed)? != canonical || !names(&removed)?.is_empty() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    dispose(&removed)?; drop(removed);
    stage.base.current()?; stage.project.current()?; root.current()?;
    match open(&stage.base.file, &stage.basename, true, FILE_READ_ATTRIBUTES, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {},
        _ => return Err(io::ErrorKind::PermissionDenied.into()),
    }
    stage.cleaned = true; stage.unknown = false;
    Ok(())
}

pub fn inspect_destination(root: &Root, relative: &str, deadline_ms: u64) -> io::Result<Identity> {
    if deadline_ms == 0 || deadline_ms > 30_000 { return Err(io::ErrorKind::InvalidInput.into()); }
    let parts = components(relative)?; let parent = parent(root, &parts)?;
    expected_file(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, &WriteExpected::Missing,
        Instant::now() + Duration::from_millis(deadline_ms))?;
    root.current()?; parent.current()?;
    no_follow::identity(&parent.file)
}

pub(crate) fn fixed_data_root() -> io::Result<&'static PathBuf> {
    let current = PathBuf::from(std::env::var_os("DEEPAGENT_WORK_DATA_ROOT").ok_or(io::ErrorKind::PermissionDenied)?);
    if !current.is_absolute() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let captured = DATA_ROOT.get_or_init(|| current.clone());
    if captured != &current { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(captured)
}
pub(crate) fn same_volume(left: &Identity, right: &Identity) -> io::Result<()> {
    if !matches!((left, right), (Identity::Windows { volume_serial: a, .. }, Identity::Windows { volume_serial: b, .. }) if a == b) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}
pub(crate) fn overlaps(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().to_uppercase(); let right = right.to_string_lossy().to_uppercase();
    left == right || left.starts_with(&format!("{right}\\")) || right.starts_with(&format!("{left}\\"))
}
fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) }
fn components(relative: &str) -> io::Result<Vec<&str>> {
    let parts = no_follow::relative(relative)?;
    for part in &parts { component(part)?; }
    Ok(parts)
}
fn parent(root: &Root, parts: &[&str]) -> io::Result<LockedPath> {
    root.current()?;
    let (_, ancestors) = parts.split_last().ok_or(io::ErrorKind::InvalidInput)?;
    let mut path = root.path.clone();
    for value in ancestors { path.push(value); }
    let parent = LockedPath::open(&path, true, false)?;
    let project = LockedPath::open(&root.path, true, false)?;
    let expected = ancestors.iter().fold(project.canonical().to_owned(), |path, value| path.join(value));
    if no_follow::identity(&project.file)? != root.identity || parent.canonical() != expected {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(parent)
}
fn expected_file(parent: &LockedPath, leaf: &str, expected: &WriteExpected, deadline: Instant) -> io::Result<Option<Held>> {
    parent.current()?;
    let file = open(&parent.file, leaf, false, FILE_GENERIC_READ, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE);
    match expected {
        WriteExpected::Missing => match file { Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None), _ => Err(io::ErrorKind::AlreadyExists.into()) },
        WriteExpected::Observed { identity, sha256, bytes } => {
            let file = file?; named_file(&file, parent.canonical(), leaf)?;
            if accessible_links(&file)? != 1 || no_follow::identity(&file)? != *identity || observe(&file, deadline)? != (sha256.clone(), *bytes) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            Ok(Some(Held { file, identity: identity.clone(), hash: sha256.clone(), bytes: *bytes }))
        },
    }
}
pub(crate) fn named_file(file: &File, parent: &Path, leaf: &str) -> io::Result<()> {
    // Preserved case/long name must match the grant spelling. An 8.3 alias or
    // alternate spelling cannot silently select a different policy member.
    if no_follow::final_path(file)? != parent.join(leaf) { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(())
}
pub(crate) fn observe(file: &File, deadline: Instant) -> io::Result<(String, u64)> {
    let before = no_follow::stamp(file)?; let bytes = file.metadata()?.len();
    if bytes > SCAN_LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
    let mut reader = file.try_clone()?; reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new(); let mut buffer = [0; 65_536]; let mut total = 0u64;
    loop {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        let read = reader.read(&mut buffer)?; if read == 0 { break; }
        total = total.checked_add(read as u64).ok_or(io::ErrorKind::InvalidData)?;
        if total > SCAN_LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
        hash.update(&buffer[..read]);
    }
    if bytes != total || no_follow::stamp(file)? != before { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok((format!("{:x}", hash.finalize()), total))
}
fn fact(held: &Held, relative: &str, retained_unlinked: bool, deadline: Instant) -> io::Result<WriteStageFile> {
    let (sha256, bytes) = observe(&held.file, deadline)?;
    if no_follow::identity(&held.file)? != held.identity || accessible_links(&held.file)? != if retained_unlinked { 0 } else { 1 } {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(WriteStageFile { relative: relative.to_owned(), identity: held.identity.clone(), sha256, bytes, retained_unlinked })
}
fn read_delete_handle(file: &File) -> io::Result<File> {
    use windows_sys::Win32::Foundation::DuplicateHandle;
    let process = unsafe { GetCurrentProcess() }; let mut handle = 0;
    if unsafe { DuplicateHandle(process, file.as_raw_handle() as HANDLE, process, &mut handle,
        FILE_GENERIC_READ | DELETE, 0, 0) } == 0 { return Err(io::Error::last_os_error()); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    let reduced = File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
    if no_follow::identity(&reduced)? != no_follow::identity(file)? { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(reduced)
}

#[repr(C)]
struct ObjectAttributes { length: u32, root_directory: HANDLE, object_name: *const UNICODE_STRING, attributes: u32,
    security_descriptor: *const c_void, security_quality_of_service: *const c_void }
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(handle: *mut HANDLE, access: u32, attributes: *const ObjectAttributes, status: *mut IO_STATUS_BLOCK,
        allocation: *const i64, attributes_file: u32, sharing: u32, disposition: u32, options: u32, ea: *const c_void, ea_bytes: u32) -> NTSTATUS;
    fn NtSetInformationFile(handle: HANDLE, status: *mut IO_STATUS_BLOCK, information: *const c_void, bytes: u32, class: i32) -> NTSTATUS;
    fn NtQueryInformationFile(handle: HANDLE, status: *mut IO_STATUS_BLOCK, information: *mut c_void, bytes: u32, class: i32) -> NTSTATUS;
}
fn component(name: &str) -> io::Result<()> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty() || name.len() > 255 || name.ends_with(['.', ' ']) || name.chars().any(|v| v.is_control() || "<>:\"/\\|?*".contains(v)) ||
        name == "." || name == ".." || ["CON", "PRN", "AUX", "NUL", "CLOCK$"].contains(&stem.as_str()) ||
        ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9')) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}
pub(crate) fn open(parent: &File, name: &str, directory: bool, access: u32, disposition: u32, descriptor: *const c_void, sharing: u32) -> io::Result<File> {
    component(name)?; let mut name = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let length = u16::try_from(name.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
    let string = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: name.as_mut_ptr() };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32, root_directory: parent.as_raw_handle() as HANDLE,
        object_name: &string, attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: descriptor, security_quality_of_service: ptr::null() };
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 }; let mut handle = 0;
    let result = unsafe { NtCreateFile(&mut handle, access | 0x0010_0000, &attributes, &mut status, ptr::null(), FILE_ATTRIBUTE_NORMAL,
        sharing, disposition, (if directory { 1 } else { 0x40 }) | 0x20, ptr::null(), 0) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
    if !directory && (!crate::regular_file::is_disk_file(&file) || !file.metadata()?.is_file()) { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(file)
}
fn rename(file: &File, parent: &File, name: &str, replace: bool) -> io::Result<()> {
    component(name)?; private_directory::require_private(file)?;
    let name = OsStr::new(name).encode_wide().collect::<Vec<_>>(); let bytes = offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())]; let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous = FILE_RENAME_INFO_0 { Flags: if replace { 0x1 | 0x2 } else { 0 } };
        (*info).RootDirectory = parent.as_raw_handle() as HANDLE; (*info).FileNameLength = (name.len() * 2) as u32;
        ptr::copy_nonoverlapping(name.as_ptr(), (&raw mut (*info).FileName).cast::<u16>(), name.len());
    }
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let result = unsafe { NtSetInformationFile(file.as_raw_handle() as HANDLE, &mut status, info.cast(), bytes as u32, 65) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); } Ok(())
}
#[repr(C)]
struct LinkInformation { accessible: u32, total: u32, delete_pending: u8, directory: u8 }
// NtQueryInformationFile probes this output on an eight-byte boundary even
// though FILE_STANDARD_LINK_INFORMATION's C layout is only four-byte aligned.
// Keep the original 12-byte ABI length while owning an aligned output buffer.
#[repr(C, align(8))]
struct LinkBuffer(LinkInformation);
pub(crate) fn accessible_links(file: &File) -> io::Result<u32> {
    let mut information = LinkBuffer(LinkInformation { accessible: 0, total: 0, delete_pending: 0, directory: 0 });
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let result = unsafe { NtQueryInformationFile(file.as_raw_handle() as HANDLE, &mut status,
        (&raw mut information.0).cast(), size_of::<LinkInformation>() as u32, 54) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    let information = information.0;
    if information.directory != 0 || information.accessible > 1 { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(information.accessible)
}
pub(crate) fn dispose(file: &File) -> io::Result<()> {
    let flags = 0x1u32 | 0x2;
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let result = unsafe { NtSetInformationFile(file.as_raw_handle() as HANDLE, &mut status, (&raw const flags).cast(), size_of::<u32>() as u32, 64) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); } Ok(())
}
pub(crate) fn names(file: &File) -> io::Result<Vec<String>> {
    let mut result = Vec::new(); let mut storage = [0usize; 1024]; let mut restart = true;
    loop {
        if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as HANDLE, if restart { FileIdBothDirectoryRestartInfo } else { FileIdBothDirectoryInfo },
            storage.as_mut_ptr().cast(), size_of_val(&storage) as u32) } == 0 {
            let error = io::Error::last_os_error(); if error.raw_os_error() == Some(18) { break; } return Err(error);
        }
        restart = false; let mut offset = 0usize;
        loop {
            if offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) > size_of_val(&storage) { return Err(io::ErrorKind::InvalidData.into()); }
            let entry = unsafe { &*storage.as_ptr().cast::<u8>().add(offset).cast::<FILE_ID_BOTH_DIR_INFO>() };
            let length = entry.FileNameLength as usize;
            if length % 2 != 0 || offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) + length > size_of_val(&storage) { return Err(io::ErrorKind::InvalidData.into()); }
            let units = unsafe { std::slice::from_raw_parts((&raw const entry.FileName).cast::<u16>(), length / 2) };
            let name = std::ffi::OsString::from_wide(units).into_string().map_err(|_| io::ErrorKind::InvalidData)?;
            if name != "." && name != ".." {
                component(&name)?;
                if entry.FileAttributes & (0x10 | 0x400) != 0 || result.len() >= 2 { return Err(io::ErrorKind::PermissionDenied.into()); }
                result.push(name);
            }
            if entry.NextEntryOffset == 0 { break; }
            let next = entry.NextEntryOffset as usize;
            if next < offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) || next % 8 != 0 { return Err(io::ErrorKind::InvalidData.into()); }
            offset = offset.checked_add(next).ok_or(io::ErrorKind::InvalidData)?;
        }
    }
    result.sort(); Ok(result)
}
