//! Held native private storage. Parent/ancestor handles stay open for the entire
//! bounded channel. Read paths never create files or modify security descriptors.
use super::{Observation, Purpose};
use crate::{no_follow::{self, LockedPath}, private_directory::{self, Descriptor}, protocol::Identity};
use sha2::{Digest, Sha256};
use std::{ffi::{c_void, OsStr}, fs::File, io::{self, Read, Seek, SeekFrom, Write}, mem::{offset_of, size_of, MaybeUninit},
    os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}},
    path::Path, ptr, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING},
    Security::{DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        EqualSid, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        Authorization::{GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT}},
    Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
        FILE_RENAME_INFO, FILE_RENAME_INFO_0, FILE_DISPOSITION_INFO, FileDispositionInfo,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE, SetFileInformationByHandle},
    System::{IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0}, Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE}}};

pub enum Failure { BeforePublish, Changed, Unknown }

struct PinnedInstallation { file: File, observation: Observation }

pub struct Lease {
    parent: LockedPath,
    pub identity: Identity,
    purpose: Purpose,
    deadline: Instant,
    installation: Option<PinnedInstallation>,
}

impl Lease {
    pub fn open(value: &str, purpose: Purpose, prepare: bool, deadline_ms: u64) -> io::Result<Self> {
        let path = Path::new(value);
        let parent = match LockedPath::open(path, true, false) {
            Ok(parent) => parent,
            Err(error) if prepare && error.kind() == io::ErrorKind::NotFound => {
                let outer = LockedPath::open(path.parent().ok_or(io::ErrorKind::InvalidInput)?, true, false)?;
                outer.current()?;
                require_owner(&outer.file)?;
                let name = path.file_name().and_then(OsStr::to_str).ok_or(io::ErrorKind::InvalidInput)?;
                let created = create(&outer.file, name, true)?;
                let expected = no_follow::identity(&created)?;
                drop(created);
                let parent = LockedPath::open(path, true, false)?;
                outer.current()?;
                if no_follow::identity(&parent.file)? != expected { return Err(io::ErrorKind::PermissionDenied.into()); }
                parent
            },
            Err(error) => return Err(error),
        };
        require_owner(&parent.file)?;
        if prepare && private_directory::require_private(&parent.file).is_err() {
            // Explicit prepare may tighten only this original current-user-owned DAC root.
            // The trusted installed caller must bind the root/purpose; JSON is not that authority.
            let outer = LockedPath::open(path.parent().ok_or(io::ErrorKind::InvalidInput)?, true, false)?;
            let name = path.file_name().and_then(OsStr::to_str).ok_or(io::ErrorKind::InvalidInput)?;
            let control = open(&outer.file, name, true, FILE_READ_ATTRIBUTES | 0x0002_0000 | 0x0004_0000, 1, ptr::null())?;
            parent.current()?;
            outer.current()?;
            if no_follow::identity(&control)? != no_follow::identity(&parent.file)? { return Err(io::ErrorKind::PermissionDenied.into()); }
            require_owner(&control)?;
            protect(&control)?;
        }
        parent.current()?;
        private_directory::require_private(&parent.file)?;
        let identity = no_follow::identity(&parent.file)?;
        Ok(Self { parent, identity, purpose, deadline: Instant::now() + Duration::from_millis(deadline_ms), installation: None })
    }

    pub fn current(&self) -> io::Result<()> {
        if Instant::now() >= self.deadline { return Err(io::ErrorKind::TimedOut.into()); }
        self.parent.current()?;
        private_directory::require_private(&self.parent.file)?;
        if no_follow::identity(&self.parent.file)? != self.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        if let Some(pin) = &self.installation {
            // This fixed credential leaf remains deny-WRITE/DELETE for the
            // original lease. Every use still observes actual bounded bytes;
            // neither elapsed time nor a copied hash authenticates its key.
            self.require_leaf(&pin.file, "installation.json")?;
            if no_follow::identity(&pin.file)? != pin.observation.identity ||
                no_follow::stamp(&pin.file)? != pin.observation.stamp ||
                pin.file.metadata()?.len() != pin.observation.bytes || pin.observation.bytes > 1024 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let mut reader = &pin.file;
            reader.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::with_capacity(pin.observation.bytes as usize + 1);
            let valid = (|| -> io::Result<bool> {
                reader.take(pin.observation.bytes + 1).read_to_end(&mut bytes)?;
                Ok(bytes.len() as u64 == pin.observation.bytes &&
                    format!("{:x}", Sha256::digest(&bytes)) == pin.observation.sha256 &&
                    no_follow::stamp(&pin.file)? == pin.observation.stamp)
            })();
            bytes.fill(0);
            let valid = valid?;
            self.parent.current()?;
            self.require_leaf(&pin.file, "installation.json")?;
            if !valid { return Err(io::ErrorKind::PermissionDenied.into()); }
        }
        Ok(())
    }

    /// A single fixed-purpose original leaf pin, never an arbitrary-path cache.
    pub fn pin_installation(&mut self) -> io::Result<(Observation, Vec<u8>)> {
        if !matches!(self.purpose, Purpose::LocalOperator) || self.installation.is_some() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let (file, observation, mut bytes) = self.observe("installation.json", FILE_SHARE_READ)?;
        self.installation = Some(PinnedInstallation { file, observation: observation.clone() });
        if let Err(error) = self.current() { bytes.fill(0); return Err(error); }
        Ok((observation, bytes))
    }

    pub fn current_pinned_installation(&self) -> io::Result<()> {
        if self.installation.is_none() { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.current()
    }

    pub fn read(&self, name: &str) -> io::Result<Option<(Observation, Vec<u8>)>> {
        self.require_name(name)?;
        match self.observe(name, FILE_SHARE_READ) {
            Ok((_, observation, bytes)) => Ok(Some((observation, bytes))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => { self.current()?; Ok(None) },
            Err(error) => Err(error),
        }
    }

    pub fn publish(&self, name: &str, id: &str, bytes: &[u8], sha256: &str, expected: Option<&Observation>) -> Result<Observation, Failure> {
        if self.installation.is_some() { return Err(Failure::Changed); }
        self.require_name(name).map_err(|_| Failure::BeforePublish)?;
        if bytes.len() > self.purpose.limit() || std::str::from_utf8(bytes).is_err() ||
            format!("{:x}", Sha256::digest(bytes)) != sha256 { return Err(Failure::BeforePublish); }
        let original = if let Some(expected) = expected {
            let current = self.observe(name, FILE_SHARE_READ | FILE_SHARE_DELETE).map_err(|_| Failure::Changed)?;
            if &current.1 != expected { return Err(Failure::Changed); }
            Some(current)
        } else {
            match self.observe(name, FILE_SHARE_READ) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                _ => return Err(Failure::Changed),
            }
            None
        };
        self.current().map_err(|_| Failure::BeforePublish)?;
        let temporary = format!(".dac-private-{id}.tmp");
        let mut file = create(&self.parent.file, &temporary, false).map_err(|_| Failure::BeforePublish)?;
        let identity = no_follow::identity(&file).map_err(|_| Failure::Unknown)?;
        let prepare = (|| -> io::Result<()> {
            file.write_all(bytes)?;
            file.sync_all()?;
            private_directory::require_private(&file)?;
            self.current()?;
            if no_follow::identity(&file)? != identity { return Err(io::ErrorKind::PermissionDenied.into()); }
            if let Some((held, observed, _)) = &original {
                self.require_leaf(held, name)?;
                if no_follow::identity(held)? != observed.identity || no_follow::stamp(held)? != observed.stamp {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                if &self.observe(name, FILE_SHARE_READ | FILE_SHARE_DELETE)?.1 != observed { return Err(io::ErrorKind::InvalidData.into()); }
            } else if self.read(name)?.is_some() { return Err(io::ErrorKind::AlreadyExists.into()); }
            Ok(())
        })();
        if prepare.is_err() {
            return match self.discard(&file, &temporary, &identity) { Ok(()) => Err(Failure::BeforePublish), Err(_) => Err(Failure::Unknown) };
        }
        // FileRenameInfoEx is an atomic namespace operation on the original opened stage.
        // POSIX semantics permit retaining the old read handle through replacement. This
        // is optimistic publication, not OS compare-and-swap; no fallback copy/delete exists.
        if let Err(error) = rename(&file, &self.parent.file, name, expected.is_some()) {
            diagnostic("publication-rename", error);
            // At the publication syscall boundary the result may be ambiguous. Preserve
            // the original stage/intent for explicit reconciliation; never overwrite again.
            return Err(Failure::Unknown);
        }
        let after = (|| -> io::Result<Observation> {
            file.sync_all()?;
            self.current()?;
            private_directory::require_private(&file)?;
            // The original created handle still denies other writers/deleters. A separate
            // ordinary LockedPath would reject even OUR held writable stage handle, so only
            // this owned publication read shares its rights while comparing the exact FileID.
            let named = open_with_share(&self.parent.file, name, false, FILE_GENERIC_READ, 1, ptr::null(),
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)?;
            private_directory::require_private(&named)?;
            if no_follow::identity(&named)? != identity { return Err(io::ErrorKind::InvalidData.into()); }
            let before = no_follow::stamp(&file)?;
            file.seek(SeekFrom::Start(0))?;
            let mut content = Vec::with_capacity(bytes.len() + 1);
            (&file).take(bytes.len() as u64 + 1).read_to_end(&mut content)?;
            self.current()?;
            if no_follow::stamp(&file)? != before || no_follow::stamp(&named)? != before ||
                no_follow::final_path(&file)? != self.parent.canonical().join(name) { return Err(io::ErrorKind::InvalidData.into()); }
            let observed = Observation { identity: identity.clone(), stamp: before, bytes: content.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&content)) };
            if observed.identity != identity || observed.sha256 != sha256 || content != bytes {
                return Err(io::ErrorKind::InvalidData.into());
            }
            Ok(observed)
        })();
        after.map_err(|error| { diagnostic("publication-observe", error); Failure::Unknown })
    }

    fn require_name(&self, name: &str) -> io::Result<()> {
        self.current()?;
        if !self.purpose.permits(name) { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(())
    }

    fn observe(&self, name: &str, sharing: u32) -> io::Result<(File, Observation, Vec<u8>)> {
        self.current()?;
        // The original parent handle is the authority. Reopening its OS-observed
        // Volume GUID alias would encounter a namespace reparse point, and a
        // path reconstruction would discard the held ancestor relationship.
        // Ordinary reads deny deletion. Only the optimistic publisher permits
        // deletion sharing so its own POSIX replacement can retain the old FileID.
        let held = open_with_share(&self.parent.file, name, false, FILE_GENERIC_READ, 1, ptr::null(), sharing)
            .map_err(|error| diagnostic("observe-open", error))?;
        self.require_leaf(&held, name)?;
        let identity = no_follow::identity(&held)?;
        let before = no_follow::stamp(&held)?;
        let length = held.metadata()?.len();
        if length > self.purpose.limit() as u64 { return Err(io::ErrorKind::InvalidData.into()); }
        let mut bytes = Vec::with_capacity(length as usize + 1);
        (&held).take(length + 1).read_to_end(&mut bytes)?;
        std::str::from_utf8(&bytes).map_err(|_| io::ErrorKind::InvalidData)?;
        self.current()?;
        self.require_leaf(&held, name)?;
        if bytes.len() as u64 != length || no_follow::identity(&held)? != identity || no_follow::stamp(&held)? != before {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let observation = Observation { identity, stamp: before,
            bytes: length, sha256: format!("{:x}", Sha256::digest(&bytes)) };
        Ok((held, observation, bytes))
    }

    fn require_leaf(&self, file: &File, name: &str) -> io::Result<()> {
        private_directory::require_private(file)?;
        let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, information.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if !file.metadata()?.is_file() || unsafe { information.assume_init() }.nNumberOfLinks != 1 ||
            no_follow::final_path(file)? != self.parent.canonical().join(name) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }

    fn discard(&self, file: &File, name: &str, identity: &Identity) -> io::Result<()> {
        self.current()?;
        if no_follow::identity(file)? != *identity || no_follow::final_path(file)? != self.parent.canonical().join(name) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        private_directory::require_private(file)?;
        let mut info = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        if unsafe { SetFileInformationByHandle(file.as_raw_handle() as HANDLE, FileDispositionInfo,
            (&raw mut info).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 { return Err(io::Error::last_os_error()); }
        Ok(())
    }
}

fn diagnostic(stage: &'static str, error: io::Error) -> io::Error {
    if error.kind() != io::ErrorKind::NotFound {
        eprintln!("PRIVATE_STORAGE_FAILURE stage={stage} kind={:?} os={}", error.kind(), error.raw_os_error().unwrap_or(0));
    }
    error
}

fn require_owner(file: &File) -> io::Result<()> {
    let expected = Descriptor::current_user()?;
    let mut user = ptr::null_mut(); let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(expected.pointer().cast_mut(), &mut user, &mut defaulted) } == 0 || user.is_null() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut owner = ptr::null_mut(); let mut descriptor = ptr::null_mut();
    let status = unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        &mut owner, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), &mut descriptor) };
    if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
    let valid = !owner.is_null() && unsafe { EqualSid(owner, user) } != 0;
    unsafe { windows_sys::Win32::Foundation::LocalFree(descriptor); }
    if !valid { return Err(io::ErrorKind::PermissionDenied.into()); } Ok(())
}

fn protect(file: &File) -> io::Result<()> {
    let descriptor = Descriptor::current_user()?;
    let mut present = 0; let mut defaulted = 0; let mut dacl = ptr::null_mut();
    if unsafe { GetSecurityDescriptorDacl(descriptor.pointer().cast_mut(), &mut present, &mut dacl, &mut defaulted) } == 0 ||
        present == 0 || dacl.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let status = unsafe { SetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), dacl, ptr::null_mut()) };
    if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
    private_directory::require_private(file)
}

#[repr(C)]
struct ObjectAttributes { length: u32, root_directory: HANDLE, object_name: *const UNICODE_STRING,
    attributes: u32, security_descriptor: *const c_void, security_quality_of_service: *const c_void }
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(file_handle: *mut HANDLE, desired_access: u32, object_attributes: *const ObjectAttributes,
        io_status_block: *mut IO_STATUS_BLOCK, allocation_size: *const i64, file_attributes: u32,
        share_access: u32, create_disposition: u32, create_options: u32, ea_buffer: *const c_void, ea_length: u32) -> NTSTATUS;
    fn NtSetInformationFile(file_handle: HANDLE, io_status_block: *mut IO_STATUS_BLOCK,
        file_information: *const c_void, length: u32, file_information_class: i32) -> NTSTATUS;
}

fn component(name: &str) -> io::Result<()> {
    if name.is_empty() || name.len() > 255 || name.ends_with(['.', ' ']) ||
        name.chars().any(|value| value.is_control() || "<>:\"/\\|?*".contains(value)) || name == "." || name == ".." {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$"].contains(&stem.as_str()) ||
        ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9')) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}

fn create(parent: &File, name: &str, directory: bool) -> io::Result<File> {
    let descriptor = Descriptor::current_user()?;
    let file = open(parent, name, directory, FILE_GENERIC_READ | FILE_GENERIC_WRITE | 0x0001_0000, 2, descriptor.pointer())?;
    private_directory::require_private(&file)?;
    Ok(file)
}

fn open(parent: &File, name: &str, directory: bool, access: u32, disposition: u32, descriptor: *const c_void) -> io::Result<File> {
    open_with_share(parent, name, directory, access, disposition, descriptor, FILE_SHARE_READ)
}

fn open_with_share(parent: &File, name: &str, directory: bool, access: u32, disposition: u32, descriptor: *const c_void, sharing: u32) -> io::Result<File> {
    component(name)?;
    let mut name = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let length = u16::try_from(name.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
    let string = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: name.as_mut_ptr() };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32, root_directory: parent.as_raw_handle() as HANDLE,
        object_name: &string, attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: descriptor, security_quality_of_service: ptr::null() };
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let mut handle = 0;
    let result = unsafe { NtCreateFile(&mut handle, access | 0x0010_0000, &attributes, &mut status,
        ptr::null(), FILE_ATTRIBUTE_NORMAL, sharing, disposition,
        (if directory { 1 } else { 0x40 }) | 0x20, ptr::null(), 0) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
    if !directory && !crate::regular_file::is_disk_file(&file) { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(file)
}

fn rename(file: &File, parent: &File, name: &str, replace: bool) -> io::Result<()> {
    component(name)?;
    private_directory::require_private(file)?;
    private_directory::require_private(parent)?;
    let name = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let bytes = offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous = FILE_RENAME_INFO_0 { Flags: if replace { 0x1 | 0x2 } else { 0 } };
        (*info).RootDirectory = parent.as_raw_handle() as HANDLE;
        (*info).FileNameLength = (name.len() * 2) as u32;
        ptr::copy_nonoverlapping(name.as_ptr(), (&raw mut (*info).FileName).cast::<u16>(), name.len());
    }
    // The NT information class accepts the original relative RootDirectory.
    // The Win32 wrapper rejects this held-parent form with ERROR_INVALID_PARAMETER.
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let result = unsafe { NtSetInformationFile(file.as_raw_handle() as HANDLE, &mut status, info.cast(), bytes as u32, 65) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dac-private-storage-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }
    fn id(value: u8) -> String { format!("{value:032x}") }
    fn hash(value: &[u8]) -> String { format!("{:x}", Sha256::digest(value)) }

    #[test]
    fn original_installation_pin_holds_leaf_until_lease_close_and_rejects_other_purpose() {
        let root = root();
        let bytes = b"{\"version\":1,\"instanceID\":\"local_0123456789abcdef0123456789abcdef\",\"secret\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}";
        let mut lease = Lease::open(root.to_str().unwrap(), Purpose::LocalOperator, true, 30_000).unwrap();
        assert!(lease.current_pinned_installation().is_err());
        lease.publish("installation.json", &id(1), bytes, &hash(bytes), None).ok().unwrap();
        let (original, observed) = lease.pin_installation().unwrap();
        assert_eq!(observed, bytes);
        assert_eq!(original.sha256, hash(bytes));
        lease.current_pinned_installation().unwrap();
        assert!(lease.pin_installation().is_err());
        assert!(std::fs::OpenOptions::new().write(true).open(root.join("installation.json")).is_err());
        assert!(std::fs::remove_file(root.join("installation.json")).is_err());
        assert!(matches!(lease.publish("installation.json", &id(2), bytes, &hash(bytes), Some(&original)), Err(Failure::Changed)));
        drop(lease);
        std::fs::OpenOptions::new().write(true).open(root.join("installation.json")).unwrap();
        let mut wrong = Lease::open(root.to_str().unwrap(), Purpose::Settings, false, 30_000).unwrap();
        assert!(wrong.pin_installation().is_err());
        drop(wrong);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_create_and_replace_keep_real_file_id_bytes_and_reject_changed_expectation() {
        let root = root();
        {
            assert!(Lease::open(root.to_str().unwrap(), Purpose::Settings, false, 30_000).is_err());
            assert!(!root.exists());
            let lease = Lease::open(root.to_str().unwrap(), Purpose::Settings, true, 30_000).unwrap();
            assert!(lease.read("settings.json").unwrap().is_none());
            let bytes = b"{\"deepagent\":{\"agentMode\":\"general\"}}";
            let first = lease.publish("settings.json", &id(1), bytes, &hash(bytes), None).ok().unwrap();
            let observed = lease.read("settings.json").unwrap().unwrap();
            assert_eq!(first, observed.0); assert_eq!(observed.1, bytes);
            assert!(matches!(lease.publish("settings.json", &id(2), b"{}", &hash(b"{}"), None), Err(Failure::Changed)));
            let mut wrong = first.clone(); wrong.sha256 = "0".repeat(64);
            assert!(matches!(lease.publish("settings.json", &id(3), b"{}", &hash(b"{}"), Some(&wrong)), Err(Failure::Changed)));
            assert_eq!(lease.read("settings.json").unwrap().unwrap().1, bytes);
            let next = lease.publish("settings.json", &id(4), b"{}", &hash(b"{}"), Some(&first)).ok().unwrap();
            assert_ne!(first.identity, next.identity);
            assert_eq!(lease.read("settings.json").unwrap().unwrap(), (next, b"{}".to_vec()));
            assert!(lease.read("account.json").is_err());
            assert!(lease.read("../settings.json").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inherited_leaf_acl_hard_links_expiry_and_payload_capacity_are_refused() {
        let root = root();
        {
            let lease = Lease::open(root.to_str().unwrap(), Purpose::LocalOperator, true, 30_000).unwrap();
            assert!(matches!(lease.publish("installation.json", &id(5), &vec![b'x'; 1025], &hash(&vec![b'x'; 1025]), None), Err(Failure::BeforePublish)));
            assert!(!root.join("installation.json").exists());
            let bytes = b"{\"version\":1}";
            lease.publish("installation.json", &id(6), bytes, &hash(bytes), None).ok().unwrap();
            std::fs::hard_link(root.join("installation.json"), root.join("alias.json")).unwrap();
            assert!(lease.read("installation.json").is_err());
            std::fs::remove_file(root.join("alias.json")).unwrap();
            assert_eq!(lease.read("installation.json").unwrap().unwrap().1, bytes);
            // An ordinary inherited ACL is not a protected private leaf, even under
            // this owned private root. Reading never silently tightens that file.
            std::fs::write(root.join("settings.json"), bytes).unwrap();
            let settings = Lease::open(root.to_str().unwrap(), Purpose::Settings, false, 30_000).unwrap();
            assert!(settings.read("settings.json").is_err());
            let expired = Lease::open(root.to_str().unwrap(), Purpose::LocalOperator, false, 1).unwrap();
            std::thread::sleep(Duration::from_millis(5));
            assert!(expired.read("installation.json").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
