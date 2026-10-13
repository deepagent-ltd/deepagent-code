//! Bounded Windows baseline/allocation observations from the original root handle.
//! Enumeration records are names only: every accepted member is reopened relative
//! to its held parent with OBJ_DONT_REPARSE, then checked by FileID and stamp.
use super::{BLOB, BYTES, CUSTODY, DIRECTORIES, FILES, windows};
use crate::{no_follow, protocol::PathRule, root::Root};
use std::{collections::BTreeSet, ffi::{OsStr, c_void}, fs::File, io, mem::{MaybeUninit, offset_of, size_of},
    os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}}, ptr, time::Instant};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING},
    Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE,
        FILE_ID_BOTH_DIR_INFO, FILE_STANDARD_INFO, FileStandardInfo, FileIdBothDirectoryInfo,
        FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx},
    System::{IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0}, Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE}}};

#[repr(C)]
struct ObjectAttributes { length: u32, root_directory: HANDLE, object_name: *const UNICODE_STRING,
    attributes: u32, security_descriptor: *const c_void, security_quality_of_service: *const c_void }
#[repr(C)]
struct FullSize { total: i64, caller_available: i64, actual_available: i64, sectors: u32, sector_bytes: u32 }
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(handle: *mut HANDLE, access: u32, attributes: *const ObjectAttributes,
        status: *mut IO_STATUS_BLOCK, allocation: *const i64, flags: u32, share: u32,
        disposition: u32, options: u32, ea: *const c_void, ea_length: u32) -> NTSTATUS;
    fn NtQueryVolumeInformationFile(handle: HANDLE, status: *mut IO_STATUS_BLOCK,
        information: *mut c_void, length: u32, class: u32) -> NTSTATUS;
}

fn status() -> IO_STATUS_BLOCK { IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 } }

/// Fresh directory handles keep each enumeration cursor independent. Ordinary
/// baseline reads permit concurrent writers, which the complete before/after
/// inventory and per-member stamps detect; this is not an atomic snapshot.
pub(crate) fn member(parent: &File, name: &str, directory: bool) -> io::Result<File> {
    open(parent, name, directory, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
}
pub(crate) fn deleting(parent: &File, name: &str, directory: bool) -> io::Result<File> {
    open(parent, name, directory, 0x0001_0000, FILE_SHARE_READ)
}
fn open(parent: &File, name: &str, directory: bool, access: u32, sharing: u32) -> io::Result<File> {
    // ReOpenFile rejects the original NtCreateFile attribute-only root on this
    // target. An empty NT relative name reopens that exact held object with the
    // read/list access needed by the independent enumeration file object.
    if name == "." {
        if !directory { return Err(io::ErrorKind::InvalidInput.into()); }
        let identity = no_follow::identity(parent)?;
        let path = no_follow::final_path(parent)?;
        let file = open_named(parent, "", true, access, sharing).map_err(|error|diagnostic("root-nt-reopen",error))?;
        let value = standard(&file)?;
        if value.Directory != 1 || value.DeletePending != 0 || no_follow::identity(&file)? != identity ||
            no_follow::identity(parent)? != identity || no_follow::final_path(&file)? != path || no_follow::final_path(parent)? != path {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        return Ok(file);
    }
    windows::component(name)?;
    open_named(parent, name, directory, access, sharing)
}
fn open_named(parent: &File, name: &str, directory: bool, access: u32, sharing: u32) -> io::Result<File> {
    open_kind(parent, name, Some(directory), access, sharing)
}
fn open_kind(parent: &File, name: &str, directory: Option<bool>, access: u32, sharing: u32) -> io::Result<File> {
    let mut text = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let length = u16::try_from(text.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
    let name = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: if text.is_empty(){ptr::null_mut()}else{text.as_mut_ptr()} };
    let attributes = ObjectAttributes { length: size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle() as HANDLE, object_name: &name,
        attributes: OBJ_CASE_INSENSITIVE as u32 | OBJ_DONT_REPARSE as u32,
        security_descriptor: ptr::null(), security_quality_of_service: ptr::null() };
    let mut result = status(); let mut handle = 0;
    let code = unsafe { NtCreateFile(&mut handle, FILE_GENERIC_READ | 0x0010_0000 | access, &attributes, &mut result,
        ptr::null(), FILE_ATTRIBUTE_NORMAL, sharing,
        1, (match directory { Some(true) => 1, Some(false) => 0x40, None => 0 }) | 0x20, ptr::null(), 0) };
    if code < 0 {
        let stage = match (access & 0x0001_0000 != 0, directory) {
            (true, Some(true)) => "member-delete-directory", (true, Some(false)) => "member-delete-file",
            (false, Some(true)) => "member-read-directory", (false, Some(false)) => "member-read-file",
            _ => "relative-member",
        };
        return Err(diagnostic(stage,io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(code) } as i32)));
    }
    if handle == 0 || handle == INVALID_HANDLE_VALUE { return Err(io::ErrorKind::InvalidData.into()); }
    let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
    let value = standard(&file)?;
    if directory.is_some_and(|directory| value.Directory != u8::from(directory)) || value.DeletePending != 0 ||
        value.Directory == 0 && (value.NumberOfLinks != 1 || !crate::regular_file::is_disk_file(&file)) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let expected = if text.is_empty() { no_follow::final_path(parent)? } else {
        no_follow::final_path(parent)?.join(String::from_utf16(&text).map_err(|_| io::ErrorKind::InvalidInput)?)
    };
    if no_follow::final_path(&file)? != expected { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(file)
}

fn standard(file: &File) -> io::Result<FILE_STANDARD_INFO> {
    let mut value = MaybeUninit::<FILE_STANDARD_INFO>::uninit();
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as HANDLE, FileStandardInfo,
        value.as_mut_ptr().cast(), size_of::<FILE_STANDARD_INFO>() as u32) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { value.assume_init() })
}

pub(crate) fn allocation(file: &File) -> io::Result<u64> {
    let value = standard(file)?;
    if value.DeletePending != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    u64::try_from(value.AllocationSize).map_err(|_| io::ErrorKind::InvalidData.into())
}

pub(crate) fn names(directory: &File, deadline: Instant) -> io::Result<Vec<(String, bool)>> {
    let fresh = member(directory, ".", true)?;
    if no_follow::identity(&fresh)? != no_follow::identity(directory)? { return Err(io::ErrorKind::PermissionDenied.into()); }
    let before = no_follow::stamp(directory)?;
    let mut buffer = vec![0usize; 8192]; let bytes = buffer.len() * size_of::<usize>();
    let mut result = Vec::new(); let mut restart = true;
    loop {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        buffer.fill(0);
        if unsafe { GetFileInformationByHandleEx(fresh.as_raw_handle() as HANDLE,
            if restart { FileIdBothDirectoryRestartInfo } else { FileIdBothDirectoryInfo },
            buffer.as_mut_ptr().cast(), bytes as u32) } == 0 {
            let error = io::Error::last_os_error(); if error.raw_os_error() == Some(18) { break; } return Err(diagnostic("directory-enumerate",error));
        }
        restart = false; let mut offset = 0;
        loop {
            if offset + size_of::<FILE_ID_BOTH_DIR_INFO>() > bytes { return Err(io::ErrorKind::InvalidData.into()); }
            let record = unsafe { &*buffer.as_ptr().cast::<u8>().add(offset).cast::<FILE_ID_BOTH_DIR_INFO>() };
            let count = record.FileNameLength as usize;
            if count == 0 || count % 2 != 0 || count > 510 ||
                offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) + count > bytes { return Err(io::ErrorKind::InvalidData.into()); }
            let name = String::from_utf16(unsafe { std::slice::from_raw_parts((&raw const record.FileName).cast::<u16>(), count / 2) })
                .map_err(|_| io::ErrorKind::InvalidData)?;
            if name != "." && name != ".." {
                windows::component(&name)?;
                // The scoped caller filters denied names before opening members.
                // Every accepted open independently rejects reparses in NtCreateFile.
                if result.len() >= FILES as usize + DIRECTORIES + 1 {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                result.push((name, record.FileAttributes & 0x10 != 0));
            }
            if record.NextEntryOffset == 0 { break; }
            let next = record.NextEntryOffset as usize;
            if next < offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) || next % 8 != 0 || offset + next >= bytes {
                return Err(io::ErrorKind::InvalidData.into());
            }
            offset += next;
        }
    }
    if result.iter().map(|(name, _)| name.to_uppercase()).collect::<BTreeSet<_>>().len() != result.len() ||
        no_follow::stamp(directory)? != before { return Err(io::ErrorKind::InvalidData.into()); }
    result.sort(); Ok(result)
}
fn diagnostic(stage:&'static str,error:io::Error)->io::Error {
    eprintln!("DAC_EVENT_WINDOWS_FS_PHASE {stage} {:?} {}",error.kind(),error.raw_os_error().unwrap_or(0));error
}

pub(crate) fn headroom(root: &Root, reservation: u64) -> io::Result<u64> {
    root.current()?;
    if reservation == 0 || reservation > 4_294_967_296 { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut value = MaybeUninit::<FullSize>::uninit(); let mut result = status();
    // FileFsFullSizeInformation reports quota-aware caller availability through
    // the original volume handle, without reopening a Volume-GUID path alias.
    let code = unsafe { NtQueryVolumeInformationFile(root.file.as_raw_handle() as HANDLE, &mut result,
        value.as_mut_ptr().cast(), size_of::<FullSize>() as u32, 7) };
    if code < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(code) } as i32)); }
    let value = unsafe { value.assume_init() };
    let unit = u64::from(value.sectors).checked_mul(u64::from(value.sector_bytes)).filter(|value| *value != 0)
        .ok_or(io::ErrorKind::InvalidData)?;
    let available = u64::try_from(value.caller_available).map_err(|_| io::ErrorKind::InvalidData)?;
    if u128::from(available) * u128::from(unit) < u128::from(reservation) { return Err(io::ErrorKind::StorageFull.into()); }
    root.current()?; Ok(unit)
}

fn matches(rule: &PathRule, relative: &str) -> bool {
    let path = rule.path.to_uppercase(); let relative = relative.to_uppercase();
    relative == path || rule.kind == "tree" && relative.starts_with(&(path + "/"))
}
fn eligible(read: &[PathRule], relative: &str) -> bool {
    read.iter().any(|rule| matches(rule, relative) || rule.path.to_uppercase().starts_with(&(relative.to_uppercase() + "/")))
}
fn safe(relative: &str) -> io::Result<()> {
    let parts = no_follow::relative(relative)?;
    if parts.len() > 32 || parts.iter().any(|name| {
        let name = name.to_ascii_lowercase(); name.starts_with(".dac-tree-") || name == ".env" || name.starts_with(".env.") ||
            matches!(name.as_str(), "auth.json" | "credentials" | "credentials.json" | ".ssh" | ".aws") || name.ends_with(".pem") || name.ends_with(".key")
    }) { return Err(io::ErrorKind::PermissionDenied.into()); } Ok(())
}

pub(crate) fn scoped_inventory(root: &Root, read: &[PathRule], deny: &[PathRule], deadline: Instant) -> io::Result<BTreeSet<String>> {
    root.current()?;
    let mut pending = vec![(String::new(), member(&root.file, ".", true)?)]; let mut result = BTreeSet::new();
    let mut entries = 0usize; let mut total = 0u64;
    while let Some((prefix, parent)) = pending.pop() {
        root.current()?; let before = names(&parent, deadline)?;
        for (name, directory) in &before {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            if name.eq_ignore_ascii_case(".git") { continue; }
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if deny.iter().any(|rule| matches(rule, &relative)) || !eligible(read, &relative) { continue; }
            safe(&relative)?; entries += 1;
            if entries > FILES as usize + DIRECTORIES { return Err(io::ErrorKind::InvalidInput.into()); }
            let file = member(&parent, name, *directory)?;
            if *directory {
                if read.iter().any(|rule| rule.kind == "file" && rule.path.eq_ignore_ascii_case(&relative)) { return Err(io::ErrorKind::InvalidData.into()); }
                pending.push((relative, file)); continue;
            }
            let bytes = file.metadata()?.len();
            total = total.checked_add(bytes).filter(|total| *total <= BYTES).ok_or(io::ErrorKind::InvalidInput)?;
            if bytes > BLOB || !read.iter().any(|rule| matches(rule, &relative)) || result.len() >= FILES as usize || !result.insert(relative) {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        if before != names(&parent, deadline)? { return Err(io::ErrorKind::InvalidData.into()); }
    }
    root.current()?; Ok(result)
}

pub(crate) fn inventory(root: &Root, expected: &BTreeSet<String>, deadline: Instant) -> io::Result<()> {
    let mut pending = vec![(String::new(), member(&root.file, ".", true)?)]; let mut seen = BTreeSet::new(); let mut entries = 0usize;
    while let Some((prefix, parent)) = pending.pop() {
        root.current()?; let before = names(&parent, deadline)?;
        for (name, directory) in &before {
            entries += 1; if entries > FILES as usize + DIRECTORIES + 1 { return Err(io::ErrorKind::InvalidInput.into()); }
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let file = member(&parent, name, *directory)?;
            if prefix.is_empty() && name == ".git" && !directory { continue; }
            if *directory {
                if !expected.iter().any(|value| value.starts_with(&format!("{relative}/"))) { return Err(io::ErrorKind::InvalidData.into()); }
                pending.push((relative, file)); continue;
            }
            if !expected.contains(&relative) || !seen.insert(relative) { return Err(io::ErrorKind::InvalidData.into()); }
        }
        if before != names(&parent, deadline)? { return Err(io::ErrorKind::InvalidData.into()); }
    }
    root.current()?; if &seen != expected { return Err(io::ErrorKind::InvalidData.into()); } Ok(())
}

pub(crate) fn directory(root: &Root, parts: &[&str]) -> io::Result<File> {
    let mut parent = member(&root.file, ".", true)?;
    for part in parts { parent = member(&parent, part, true)?; }
    root.current()?; Ok(parent)
}
pub(crate) fn current_member(root: &Root, relative: &str, file: &File, stamp: &str, directory: bool) -> io::Result<()> {
    let parts = no_follow::relative(relative)?;
    let parent = self::directory(root, &parts[..parts.len() - 1])?;
    let actual = member(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, directory)?;
    if no_follow::stamp(file)? != stamp || no_follow::stamp(&actual)? != stamp { return Err(io::ErrorKind::InvalidData.into()); } Ok(())
}

pub(crate) fn allocated(root: &Root, names: &BTreeSet<String>, deadline: Instant) -> io::Result<u64> {
    root.current()?; let mut directories = BTreeSet::new(); let mut bytes = allocation(&root.file)?;
    let mut observed = Vec::new();
    for relative in names {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        let parts = no_follow::relative(relative)?; let parent = directory(root, &parts[..parts.len() - 1])?;
        let file = member(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, false)?; let stamp = no_follow::stamp(&file)?;
        bytes = bytes.checked_add(allocation(&file)?).ok_or(io::ErrorKind::InvalidData)?;
        current_member(root, relative, &file, &stamp, false)?; observed.push((relative.clone(), file, stamp, false));
        for index in 1..parts.len() {
            let relative = parts[..index].join("/");
            if directories.insert(relative.clone()) {
                let file = directory(root, &parts[..index])?; let stamp = no_follow::stamp(&file)?;
                bytes = bytes.checked_add(allocation(&file)?).ok_or(io::ErrorKind::InvalidData)?;
                observed.push((relative, file, stamp, true));
            }
        }
        if bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); }
    }
    match open_kind(&root.file, ".git", None, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE) {
        // A source repository owns a .git directory; its objects and metadata
        // have separate Git custody. Only a worktree pointer file contributes
        // to this raw-tree allocation, as on the other supported platforms.
        Ok(file) => {
            let directory = standard(&file)?.Directory != 0;
            let stamp = no_follow::stamp(&file)?;
            if !directory { bytes = bytes.checked_add(allocation(&file)?).ok_or(io::ErrorKind::InvalidData)?; }
            observed.push((".git".to_owned(), file, stamp, directory));
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => (), Err(error) => return Err(error),
    }
    for (relative, file, stamp, directory) in observed { current_member(root, &relative, &file, &stamp, directory)?; }
    root.current()?; if bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); } Ok(bytes)
}

pub(crate) fn object_allocation(root: &Root, relative: &str) -> io::Result<u64> {
    root.current()?;
    if relative.is_empty() { return allocation(&root.file); }
    if relative == "@worktree" { return administration(root); }
    if relative.len() == 2 && relative.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) {
        let file = directory(root, &[relative])?; let stamp = no_follow::stamp(&file)?; let bytes = allocation(&file)?;
        current_member(root, relative, &file, &stamp, true)?; root.current()?; return Ok(bytes);
    }
    let (prefix, name) = relative.split_once('/').ok_or(io::ErrorKind::InvalidInput)?;
    if prefix.len() != 2 || ![38, 62].contains(&name.len()) || !prefix.bytes().chain(name.bytes()).all(|value|
        value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) { return Err(io::ErrorKind::InvalidInput.into()); }
    let parent = directory(root, &[prefix])?; let file = member(&parent, name, false)?; let stamp = no_follow::stamp(&file)?;
    let bytes = allocation(&file)?;
    if file.metadata()?.len() > 33_554_432 || bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); }
    current_member(root, relative, &file, &stamp, false)?; root.current()?; Ok(bytes)
}

fn administration(root: &Root) -> io::Result<u64> {
    let deadline = Instant::now() + std::time::Duration::from_millis(super::DEADLINE_MS);
    let allowed = ["HEAD", "index", "gitdir", "commondir", "ORIG_HEAD", "logs", "refs"];
    let before = names(&root.file, deadline)?;
    if before.iter().any(|(name, _)| !allowed.contains(&name.as_str())) { return Err(io::ErrorKind::InvalidData.into()); }
    let mut bytes = allocation(&root.file)?; let mut observed = Vec::new();
    for (name, is_directory) in &before {
        if name == "refs" || name == "logs" {
            if !is_directory { return Err(io::ErrorKind::InvalidData.into()); }
            let directory = member(&root.file, name, true)?; let stamp = no_follow::stamp(&directory)?;
            bytes = bytes.checked_add(allocation(&directory)?).ok_or(io::ErrorKind::InvalidData)?;
            let children = names(&directory, deadline)?;
            if name == "refs" && !children.is_empty() || name == "logs" && children.iter().any(|(name, directory)| name != "HEAD" || *directory) {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if name == "logs" && !children.is_empty() {
                let file = member(&directory, "HEAD", false)?; let stamp = no_follow::stamp(&file)?;
                if file.metadata()?.len() > 8192 { return Err(io::ErrorKind::InvalidData.into()); }
                bytes = bytes.checked_add(allocation(&file)?).ok_or(io::ErrorKind::InvalidData)?;
                observed.push(("logs/HEAD".to_owned(), file, stamp, false));
            }
            observed.push((name.clone(), directory, stamp, true)); continue;
        }
        if *is_directory { return Err(io::ErrorKind::InvalidData.into()); }
        let file = member(&root.file, name, false)?; let stamp = no_follow::stamp(&file)?;
        if file.metadata()?.len() > if name == "index" { BLOB } else { 8192 } { return Err(io::ErrorKind::InvalidData.into()); }
        bytes = bytes.checked_add(allocation(&file)?).ok_or(io::ErrorKind::InvalidData)?;
        observed.push((name.clone(), file, stamp, false));
    }
    for (relative, file, stamp, directory) in observed { current_member(root, &relative, &file, &stamp, directory)?; }
    if before != names(&root.file, deadline)? || bytes > CUSTODY { return Err(io::ErrorKind::InvalidData.into()); }
    root.current()?; Ok(bytes)
}
