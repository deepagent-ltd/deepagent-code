//! Private raw-tree destination handles. Every ancestor remains locked against
//! replacement; files are published through their own handle, never by a reopened path.
use crate::{no_follow::{self, LockedPath}, native_windows::private_directory::{self, Descriptor}, root::Root};
use std::{collections::BTreeMap, ffi::{OsStr, c_void}, fs::File, io, mem::{size_of, offset_of},
    os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}}, ptr};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING},
    Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
        FILE_RENAME_INFO, FILE_RENAME_INFO_0},
    System::{IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0}, Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE}}};

pub struct Lease { root: LockedPath, directories: BTreeMap<String, File> }
impl Lease {
    pub fn open(root: &Root) -> io::Result<Self> {
        let held = LockedPath::open_event_directory(&root.path)?;
        if no_follow::identity(&held.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        require_owner(&held.file)?;
        let directories = BTreeMap::from([(String::new(), held.file.try_clone()?)]);
        Ok(Self { root: held, directories })
    }
    pub fn harden(&self, root: &Root) -> io::Result<()> {
        use windows_sys::Win32::{Storage::FileSystem::{CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING},
            Security::{GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
                Authorization::{SE_FILE_OBJECT, SetSecurityInfo}}};
        self.root.current()?; root.current()?;
        let name = self.root.canonical().as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
        let handle = unsafe { CreateFileW(name.as_ptr(), 0x0006_0000, FILE_SHARE_READ, ptr::null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, 0) };
        if handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
        let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
        if no_follow::identity(&file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        require_owner(&file)?;
        let descriptor = Descriptor::current_user()?; let mut present = 0; let mut dacl = ptr::null_mut(); let mut defaulted = 0;
        if unsafe { GetSecurityDescriptorDacl(descriptor.pointer().cast_mut(), &mut present, &mut dacl, &mut defaulted) } == 0 || present == 0 || dacl.is_null() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        // Harden this exact owned empty worktree through its still-held native identity.
        // Owner and parent ACLs remain unchanged; a PATH/PowerShell chmod substitute is absent.
        let result = unsafe { SetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), dacl, ptr::null_mut()) };
        if result != 0 { return Err(io::Error::from_raw_os_error(result as i32)); }
        private_directory::require_private(&self.root.file)?; self.current(root)
    }
    pub fn current(&self, root: &Root) -> io::Result<()> {
        self.root.current()?; root.current()?;
        if no_follow::identity(&self.root.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        private_directory::require_private(&self.root.file)
    }
    pub fn parent(&mut self, parts: &[&str], create: bool) -> io::Result<File> {
        let descriptor = Descriptor::current_user()?;
        let mut prefix = String::new();
        for part in &parts[..parts.len()-1] {
            component(part)?;
            let key = if prefix.is_empty() { part.to_string() } else { format!("{prefix}/{part}") };
            if !self.directories.contains_key(&key) {
                if !create { return Err(io::ErrorKind::NotFound.into()); }
                let parent = self.directories.get(&prefix).ok_or(io::ErrorKind::InvalidData)?;
                private_directory::require_private(parent)?;
                // Existing names are refused. Only a directory created by this lease can
                // enter its map, so case aliases or foreign directories cannot be adopted.
                let directory = open(parent, part, true, &descriptor)?;
                private_directory::require_private(&directory)?;
                self.directories.insert(key.clone(), directory);
            }
            prefix = key;
        }
        self.parent_existing(parts)
    }
    pub fn parent_existing(&self, parts: &[&str]) -> io::Result<File> {
        self.root.current()?;
        let prefix = parts[..parts.len()-1].join("/");
        let parent = self.directories.get(&prefix).ok_or(io::ErrorKind::NotFound)?;
        private_directory::require_private(parent)?;
        // Mutable Event directory handles allow leaf publication through an implicit
        // write open, but never DELETE sharing or replacement of the directory itself.
        // Reopen only for a name/identity observation of the original map handle.
        let mut actual = super::windows_observation::member(&self.root.file, ".", true)?;
        for part in &parts[..parts.len()-1] { actual = super::windows_observation::member(&actual, part, true)?; }
        if no_follow::identity(&actual)? != no_follow::identity(parent)? { return Err(io::ErrorKind::PermissionDenied.into()); }
        parent.try_clone()
    }
}

fn require_owner(file: &File) -> io::Result<()> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::{EqualSid, GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT}}};
    let expected = Descriptor::current_user()?; let mut user = ptr::null_mut(); let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(expected.pointer().cast_mut(), &mut user, &mut defaulted) } == 0 || user.is_null() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut owner = ptr::null_mut(); let mut descriptor = ptr::null_mut();
    let result = unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        &mut owner, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), &mut descriptor) };
    if result != 0 { return Err(io::Error::from_raw_os_error(result as i32)); }
    let valid = !owner.is_null() && unsafe { EqualSid(owner, user) } != 0;
    unsafe { LocalFree(descriptor); }
    if !valid { return Err(io::ErrorKind::PermissionDenied.into()); } Ok(())
}

pub fn create(parent: &File, name: &str) -> io::Result<File> {
    private_directory::require_private(parent)?;
    let file = open(parent, name, false, &Descriptor::current_user()?)?;
    private_directory::require_private(&file)?;
    Ok(file)
}

pub fn publish(file: &File, parent: &File, name: &str) -> io::Result<()> {
    component(name)?; private_directory::require_private(file)?; private_directory::require_private(parent)?;
    let name = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let bytes = offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous = FILE_RENAME_INFO_0 { ReplaceIfExists: 0 };
        (*info).RootDirectory = parent.as_raw_handle() as HANDLE;
        (*info).FileNameLength = (name.len() * 2) as u32;
        ptr::copy_nonoverlapping(name.as_ptr(), (&raw mut (*info).FileName).cast::<u16>(), name.len());
    }
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    // The NT relative rename consumes the original parent handle. The Win32
    // FileRenameInfo wrapper does not support this RootDirectory contract on
    // the target platform (ERROR_INVALID_PARAMETER); no full-path fallback is used.
    let result = unsafe { NtSetInformationFile(file.as_raw_handle() as HANDLE, &mut status, info.cast(), bytes as u32, 65) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    // FILE_RENAME_INFO ReplaceIfExists=false gives an exclusive namespace publication.
    // The original opened leaf has DELETE access and stays held through the post-observe.
    Ok(())
}

#[repr(C)]
struct ObjectAttributes { length: u32, root_directory: HANDLE, object_name: *const UNICODE_STRING,
    attributes: u32, security_descriptor: *const c_void, security_quality_of_service: *const c_void }
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(file_handle: *mut HANDLE, desired_access: u32, object_attributes: *const ObjectAttributes,
        io_status_block: *mut IO_STATUS_BLOCK, allocation_size: *const i64, file_attributes: u32,
        share_access: u32, create_disposition: u32, create_options: u32, ea_buffer: *const c_void, ea_length: u32) -> NTSTATUS;
    fn NtSetInformationFile(handle: HANDLE, status: *mut IO_STATUS_BLOCK, information: *const c_void, bytes: u32, class: i32) -> NTSTATUS;
}
fn open(parent: &File, name: &str, directory: bool, descriptor: &Descriptor) -> io::Result<File> {
    component(name)?;
    let mut name = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let length = u16::try_from(name.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
    let object_name = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: name.as_mut_ptr() };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32, root_directory: parent.as_raw_handle() as HANDLE,
        object_name: &object_name, attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: descriptor.pointer(), security_quality_of_service: ptr::null() };
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 }; let mut handle = 0;
    let result = unsafe { NtCreateFile(&mut handle, FILE_GENERIC_READ | FILE_GENERIC_WRITE | 0x0012_0000 | if directory { 0 } else { 0x0001_0000 },
        &attributes, &mut status, ptr::null(), FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | if directory { 2 } else { 0 }, 2,
        (if directory { 1 } else { 0x40 }) | 0x20, ptr::null(), 0) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
}

pub(super) fn component(name: &str) -> io::Result<()> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty() || name.len() > 255 || name.ends_with(['.', ' ']) || name.chars().any(|value| value.is_control() || "<>:\"/\\|?*".contains(value)) ||
        ["CON", "PRN", "AUX", "NUL", "CLOCK$"].contains(&stem.as_str()) ||
        ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9')) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}
