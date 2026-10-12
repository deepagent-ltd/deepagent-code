// Adapted from OpenAI Codex exec-server/src/no_follow/windows.rs (Apache-2.0).
// Only read operations are retained. All descendant opens use the owned root handle.
use crate::{protocol::Identity, regular_file};
use std::{ffi::{OsStr, c_void}, fs::File, io, mem::{size_of, MaybeUninit},
    os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}},
    path::{Component, Path, Prefix}, ptr};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING},
    Security::{SECURITY_QUALITY_OF_SERVICE, SecurityIdentification},
    Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_NORMAL, FILE_BASIC_INFO,
        FILE_GENERIC_READ, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FileBasicInfo, FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx},
    System::{IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0}, Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE}}};

const DIRECTORY: u32 = 1;
const SYNCHRONOUS: u32 = 0x20;
const NON_DIRECTORY: u32 = 0x40;

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *const UNICODE_STRING,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(file_handle: *mut HANDLE, desired_access: u32,
        object_attributes: *const ObjectAttributes, io_status_block: *mut IO_STATUS_BLOCK,
        allocation_size: *const i64, file_attributes: u32, share_access: u32,
        create_disposition: u32, create_options: u32, ea_buffer: *const c_void, ea_length: u32) -> NTSTATUS;
}

fn open(root: Option<&File>, name: &OsStr, directory: bool) -> io::Result<File> {
    let mut name: Vec<u16> = name.encode_wide().collect();
    let length = u16::try_from(name.len() * size_of::<u16>()).map_err(|_| io::ErrorKind::InvalidInput)?;
    if name.contains(&0) { return Err(io::ErrorKind::InvalidInput.into()); }
    let object_name = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: name.as_mut_ptr() };
    let qos = SECURITY_QUALITY_OF_SERVICE { Length: size_of::<SECURITY_QUALITY_OF_SERVICE>() as u32,
        ImpersonationLevel: SecurityIdentification, ContextTrackingMode: 0, EffectiveOnly: 1 };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32,
        root_directory: root.map_or(0, |file| file.as_raw_handle() as HANDLE),
        object_name: &object_name, attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: ptr::null(), security_quality_of_service: (&raw const qos).cast() };
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let mut handle = 0;
    // Both the name and optional parent handle are owned for the duration of NtCreateFile.
    let result = unsafe { NtCreateFile(&mut handle,
        (if directory { FILE_READ_ATTRIBUTES } else { FILE_GENERIC_READ }) | 0x0010_0000,
        &attributes, &mut status, ptr::null(), FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 1,
        (if directory { DIRECTORY } else { NON_DIRECTORY }) | SYNCHRONOUS, ptr::null(), 0) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
}

pub fn open_root(path: &Path) -> io::Result<File> {
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::CurDir | Component::ParentDir)) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let offset = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => 0,
            Prefix::VerbatimDisk(_) => 4,
            // UNC and device namespaces are outside this local-file profile.
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        },
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    let source: Vec<u16> = path.as_os_str().encode_wide().skip(offset)
        .map(|unit| if unit == b'/' as u16 { b'\\' as u16 } else { unit }).collect();
    let name = OsStr::new("\\??\\").encode_wide().chain(source).collect::<Vec<_>>();
    use std::os::windows::ffi::OsStringExt;
    open(None, &std::ffi::OsString::from_wide(&name), true)
}

fn information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut result = MaybeUninit::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, result.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { result.assume_init() })
}

pub fn open_relative(root: &File, parts: &[&str]) -> io::Result<File> {
    let (leaf, parents) = parts.split_last().ok_or(io::ErrorKind::InvalidInput)?;
    let mut current = root.try_clone()?;
    for part in parents { current = open(Some(&current), OsStr::new(part), true)?; }
    let file = open(Some(&current), OsStr::new(leaf), false)?;
    if !regular_file::is_disk_file(&file) || !file.metadata()?.is_file() || information(&file)?.nNumberOfLinks != 1 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(file)
}

pub fn identity(file: &File) -> io::Result<Identity> {
    let mut result = MaybeUninit::<FILE_ID_INFO>::uninit();
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as HANDLE, FileIdInfo,
        result.as_mut_ptr().cast(), size_of::<FILE_ID_INFO>() as u32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { result.assume_init() };
    Ok(Identity::Windows { volume_serial: format!("{:016x}", result.VolumeSerialNumber),
        file_id: result.FileId.Identifier.iter().map(|byte| format!("{byte:02x}")).collect() })
}

pub fn stamp(file: &File) -> io::Result<String> {
    let mut result = MaybeUninit::<FILE_BASIC_INFO>::uninit();
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as HANDLE, FileBasicInfo,
        result.as_mut_ptr().cast(), size_of::<FILE_BASIC_INFO>() as u32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { result.assume_init() };
    let info = information(file)?;
    Ok(format!("{:?}:{}:{}:{}:{}:{}:{}:{}", identity(file)?, result.CreationTime, result.LastWriteTime,
        result.ChangeTime, result.FileAttributes, info.nFileSizeHigh, info.nFileSizeLow, info.nNumberOfLinks))
}

/// An installation image/snapshot lease is separate from an ordinary reader.
/// Every ancestor stays open without WRITE/DELETE sharing until this lease drops.
pub struct LockedPath {
    pub file: File,
    ancestors: Vec<File>,
    canonical: std::path::PathBuf,
    identity: Identity,
}

impl LockedPath {
    pub fn open(path: &Path, directory: bool, executable: bool) -> io::Result<Self> {
        Self::open_image(path, directory, executable, true, FILE_SHARE_READ)
    }

    /// The builtin Event producer keeps a directory's identity immovable while
    /// publishing leaves inside it. The final directory permits WRITE sharing,
    /// never DELETE sharing; this does not request any additional access rights.
    pub(crate) fn open_event_directory(path: &Path) -> io::Result<Self> {
        Self::open_image(path, true, false, true, FILE_SHARE_READ | FILE_SHARE_WRITE)
    }

    /// System32 DLLs are normally hard-linked to WinSxS. The native first-loader
    /// separately proves the fixed System32 namespace and machine-owned DACL;
    /// this observational lease does not grant installation or Work authority.
    pub fn open_system_image(path: &Path) -> io::Result<Self> {
        Self::open_image(path, false, true, false, FILE_SHARE_READ)
    }

    /// Only the original fixed Git producer uses this observational image lease.
    /// Its machine DACL, exact installed namespace and stable link count are
    /// independently verified; ordinary Work members remain single-link.
    pub(crate) fn open_original_git_image(path: &Path) -> io::Result<Self> {
        Self::open_image(path, false, true, false, FILE_SHARE_READ)
    }

    /// A stream snapshot resolves members from its original held root. Reopening
    /// the Volume-GUID description as a namespace can encounter an OS alias.
    pub fn member(root: &Self, parts: &[&str], directory: bool, executable: bool) -> io::Result<Self> {
        Self::member_image(root, parts, directory, executable, FILE_SHARE_READ)
    }

    pub(crate) fn member_event_directory(root: &Self, parts: &[&str]) -> io::Result<Self> {
        Self::member_image(root, parts, true, false, FILE_SHARE_READ | FILE_SHARE_WRITE)
    }

    fn member_image(root: &Self, parts: &[&str], directory: bool, executable: bool, sharing: u32) -> io::Result<Self> {
        root.current()?;
        if parts.is_empty() || parts.len() > 16 { return Err(io::ErrorKind::InvalidInput.into()); }
        for part in parts { validate_component(part)?; }
        let mut ancestors = root.ancestors.iter().map(File::try_clone).collect::<io::Result<Vec<_>>>()?;
        ancestors.push(root.file.try_clone()?);
        for part in &parts[..parts.len() - 1] {
            let name = std::ffi::OsStr::new(part);
            let opened = locked_open(ancestors.last(), name, true, false, 1)?;
            require_name(&opened, name)?;
            ancestors.push(opened);
        }
        let name = std::ffi::OsStr::new(parts.last().ok_or(io::ErrorKind::InvalidInput)?);
        let file = locked_open_sharing(ancestors.last(), name, directory, executable, 1, sharing)?;
        require_name(&file, name)?;
        if !directory && (!regular_file::is_disk_file(&file) || information(&file)?.nNumberOfLinks != 1) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let canonical = final_path(&file)?;
        if canonical != parts.iter().fold(root.canonical.clone(), |path, part| path.join(part)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let identity = identity(&file)?;
        root.current()?;
        Ok(Self { file, ancestors, canonical, identity })
    }

    fn open_image(path: &Path, directory: bool, executable: bool, single_link: bool, sharing: u32) -> io::Result<Self> {
        let (root, parts) = local_parts(path)?;
        if parts.is_empty() && !directory { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut ancestors = vec![locked_open(None, &root, true, false, 1)?];
        for part in &parts[..parts.len().saturating_sub(1)] {
            let parent = ancestors.last().ok_or(io::ErrorKind::InvalidData)?;
            let opened = locked_open(Some(parent), part, true, false, 1)?;
            require_name(&opened, part).map_err(|error| image_lease_diagnostic(error, "ancestor_name"))?;
            ancestors.push(opened);
        }
        let file = if let Some(leaf) = parts.last() {
            let file = locked_open_sharing(ancestors.last(), leaf, directory, executable, 1, sharing)?;
            require_name(&file, leaf).map_err(|error| image_lease_diagnostic(error, "leaf_name"))?;
            file
        } else { ancestors[0].try_clone()? };
        if !directory && !regular_file::is_disk_file(&file) {
            return Err(image_lease_diagnostic(io::ErrorKind::PermissionDenied.into(), "disk"));
        }
        if !directory && single_link && information(&file)?.nNumberOfLinks != 1 {
            return Err(image_lease_diagnostic(io::ErrorKind::PermissionDenied.into(), "singlelink"));
        }
        let canonical = final_path(&file)?;
        let identity = identity(&file)?;
        Ok(Self { file, ancestors, canonical, identity })
    }

    pub fn canonical(&self) -> &Path { &self.canonical }
    pub fn current(&self) -> io::Result<()> {
        if self.ancestors.is_empty() || identity(&self.file)? != self.identity || final_path(&self.file)? != self.canonical {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
}

fn local_parts(path: &Path) -> io::Result<(std::ffi::OsString, Vec<std::ffi::OsString>)> {
    use std::os::windows::ffi::OsStringExt;
    let mut components = path.components();
    let root = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) if drive.is_ascii_uppercase() => format!("\\??\\{}:\\", drive as char),
            Prefix::Verbatim(name) => {
                let name = name.to_str().ok_or(io::ErrorKind::InvalidInput)?;
                let guid = name.strip_prefix("Volume{").and_then(|value| value.strip_suffix('}')).ok_or(io::ErrorKind::InvalidInput)?;
                if guid.len() != 36 || !guid.bytes().enumerate().all(|(index, byte)|
                    if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }) {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
                format!("\\??\\{name}\\")
            },
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        },
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    if !matches!(components.next(), Some(Component::RootDir)) { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut parts = Vec::new();
    for component in components {
        let Component::Normal(name) = component else { return Err(io::ErrorKind::InvalidInput.into()); };
        let text = name.to_str().ok_or(io::ErrorKind::InvalidInput)?;
        validate_component(text)?;
        parts.push(std::ffi::OsString::from_wide(&name.encode_wide().collect::<Vec<_>>()));
    }
    if parts.len() > 32 { return Err(io::ErrorKind::InvalidInput.into()); }
    Ok((root.into(), parts))
}

fn validate_component(name: &str) -> io::Result<()> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty() || name.len() > 255 || name.ends_with(['.', ' ']) || name.chars().any(|value| value.is_control() || "<>:\"/\\|?*".contains(value)) ||
        ["CON", "PRN", "AUX", "NUL", "CLOCK$"].contains(&stem.as_str()) ||
        ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9')) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}

pub fn final_path(file: &File) -> io::Result<std::path::PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, VOLUME_NAME_GUID};
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = vec![0u16; 2049];
    let count = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle() as HANDLE, buffer.as_mut_ptr(), buffer.len() as u32, VOLUME_NAME_GUID) };
    if count == 0 { return Err(io::Error::last_os_error()); }
    if count as usize >= buffer.len() { return Err(io::ErrorKind::InvalidInput.into()); }
    buffer.truncate(count as usize);
    Ok(std::ffi::OsString::from_wide(&buffer).into())
}

fn require_name(file: &File, input: &OsStr) -> io::Result<()> {
    let actual = final_path(file)?;
    if !actual.file_name().and_then(OsStr::to_str).zip(input.to_str()).is_some_and(|(left, right)| left.eq_ignore_ascii_case(right)) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn image_lease_diagnostic(error: io::Error, phase: &'static str) -> io::Error {
    eprintln!("dac-native-path-lease:{phase}:{:?}:{:?}", error.kind(), error.raw_os_error());
    error
}

fn locked_open(root: Option<&File>, name: &OsStr, directory: bool, executable: bool, disposition: u32) -> io::Result<File> {
    locked_open_sharing(root, name, directory, executable, disposition, FILE_SHARE_READ)
}

fn locked_open_sharing(root: Option<&File>, name: &OsStr, directory: bool, executable: bool, disposition: u32, sharing: u32) -> io::Result<File> {
    let mut name = name.encode_wide().collect::<Vec<_>>();
    if name.contains(&0) { return Err(io::ErrorKind::InvalidInput.into()); }
    let length = u16::try_from(name.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
    let object_name = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: name.as_mut_ptr() };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32, root_directory: root.map_or(0, |file| file.as_raw_handle() as HANDLE),
        object_name: &object_name, attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: ptr::null(), security_quality_of_service: ptr::null() };
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let mut handle = 0;
    let access = (if directory { FILE_READ_ATTRIBUTES } else { FILE_GENERIC_READ }) | 0x0012_0000 | if executable { 0x20 } else { 0 };
    let result = unsafe { NtCreateFile(&mut handle, access, &attributes, &mut status, ptr::null(), FILE_ATTRIBUTE_NORMAL, sharing,
        disposition, (if directory { DIRECTORY } else { NON_DIRECTORY }) | SYNCHRONOUS, ptr::null(), 0) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
}

/// Destination creation is exclusive and relative to the original opened
/// workspace directory. The caller supplies an original native private DACL.
pub fn create_private_child(parent: &File, name: &str, directory: bool, descriptor: *const c_void) -> io::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE;
    validate_component(name)?;
    if descriptor.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut name = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let length = u16::try_from(name.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
    let object_name = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: name.as_mut_ptr() };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32, root_directory: parent.as_raw_handle() as HANDLE,
        object_name: &object_name, attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: descriptor, security_quality_of_service: ptr::null() };
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    let mut handle = 0;
    let result = unsafe { NtCreateFile(&mut handle, FILE_GENERIC_READ | FILE_GENERIC_WRITE, &attributes, &mut status, ptr::null(),
        FILE_ATTRIBUTE_NORMAL, 0, 2, (if directory { DIRECTORY } else { NON_DIRECTORY }) | SYNCHRONOUS, ptr::null(), 0) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
}

#[cfg(test)]
mod locked_tests {
    use super::{LockedPath, identity};
    #[test]
    fn locked_chain_blocks_write_and_delete_and_keeps_real_file_id() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("dac-image-lease-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let name = root.join("image.exe");
        std::fs::write(&name, b"private lease data").unwrap();
        {
            let lease = LockedPath::open(&name, false, false).unwrap();
            assert_eq!(identity(&lease.file).unwrap(), identity(&std::fs::File::open(&name).unwrap()).unwrap());
            assert!(std::fs::OpenOptions::new().write(true).share_mode(7).open(&name).is_err());
            assert!(std::fs::rename(&name, root.join("changed.exe")).is_err());
            assert!(std::fs::remove_file(&name).is_err());
            lease.current().unwrap();
        }
        std::fs::remove_file(name).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
