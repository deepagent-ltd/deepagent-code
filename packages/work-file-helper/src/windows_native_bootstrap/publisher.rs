//! Offline publisher preparation and observation. These held files are never Installed,
//! preloaded, Registered, or Work permits, and this module cannot execute them.
use super::loader::{self, FirstLoad};
use crate::{no_follow::{self, LockedPath}, protocol::Identity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, ffi::c_void, fs::File, io::{self, Read, Seek, SeekFrom}, mem::{offset_of, size_of},
    os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle}}, path::Path, ptr, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{HANDLE, LocalFree}, Security::{ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
    AclSizeInformation, AddAce, AddAccessAllowedAceEx, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, UNPROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED, SE_DACL_AUTO_INHERITED,
    EqualSid, GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorControl, InitializeAcl, IsValidAcl,
    Authorization::{ConvertStringSidToSidW, GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT}},
    Storage::FileSystem::{CreateFileW, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING}};

const LIMIT: u64 = 268_435_456;
const ARAP_RX: u32 = 0x0012_00a9;
#[derive(Serialize)]
struct Fingerprint { bytes: u64, sha256: String }
#[derive(Serialize)]
struct Description { version: u8, purpose: &'static str, artifact: Fingerprint, runtime: Fingerprint }
pub struct Publisher { artifact: LockedPath, runtime: LockedPath, stamps: [String; 2], description: String, created: Instant }
impl Publisher {
    /// Offline preparation only, before the publisher's immutable observation.
    /// One fixed, already-built Bun image receives one non-inheriting RX ACE.
    /// No caller path, SID, mask, directory or execution lease is accepted.
    pub fn prepare_work_runtime(original: &FirstLoad) -> io::Result<String> {
        Self::prepare_fixed_work_runtime(original, "node.js.native-components.json")
    }
    pub fn prepare_cli_work_runtime(original: &FirstLoad) -> io::Result<String> {
        Self::prepare_fixed_work_runtime(original, "deepagent-code.exe.native-components.json")
    }
    fn prepare_fixed_work_runtime(original: &FirstLoad, components_name: &'static str) -> io::Result<String> {
        original.current()?;
        let directory = original.bootstrap_path()?.parent().ok_or(io::ErrorKind::Unsupported)?.to_owned();
        let manifest = LockedPath::open(&directory.join(components_name), false, false)?;
        loader::require_trusted(&manifest.file)?;
        let stamp = no_follow::stamp(&manifest.file)?;
        let bytes = manifest.file.metadata()?.len();
        if bytes == 0 || bytes > 1_048_576 { return Err(io::ErrorKind::InvalidData.into()); }
        let mut reader = manifest.file.try_clone()?; reader.seek(SeekFrom::Start(0))?;
        let mut text = Vec::with_capacity(bytes as usize);
        reader.take(bytes + 1).read_to_end(&mut text)?;
        if text.len() as u64 != bytes { return Err(io::ErrorKind::InvalidData.into()); }
        let components: Components = serde_json::from_slice(&text)?;
        let target = if cfg!(target_arch="aarch64") { "win32-arm64" } else { "win32-x64" };
        if components.schema_version != "dac.native-components.v1" || components.target != target ||
            !hex(&components.source_commit, 40) || !hex(&components.source_tree, 40) ||
            components.components.is_empty() || components.components.len() > 4096 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut paths = HashSet::new();
        for component in &components.components {
            if component.path.len() > 512 || !component.path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." &&
                part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.@%+-".contains(&byte))) ||
                !paths.insert(&component.path) || component.bytes == 0 || component.bytes > 1_073_741_824 || !hex(&component.sha256, 64) {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        let asset_path = format!("packages/work-file-helper/bin/{target}/bun-command-runtime.exe");
        let expected = components.components.iter().find(|component| component.path == asset_path).ok_or(io::ErrorKind::PermissionDenied)?;
        let image = LockedPath::open(&directory.join("bun-command-runtime.exe"), false, true)?;
        let identity = no_follow::identity(&image.file)?;
        let observed = fingerprint(&image)?;
        if observed.bytes != expected.bytes || observed.sha256 != expected.sha256 { return Err(io::ErrorKind::PermissionDenied.into()); }
        manifest.current()?; image.current()?; original.current()?;
        if no_follow::stamp(&manifest.file)? != stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
        grant_fixed_runtime_rx(&image)?;
        original.current()?; manifest.current()?; image.current()?; loader::require_trusted(&image.file)?;
        if no_follow::stamp(&manifest.file)? != stamp || no_follow::identity(&image.file)? != identity {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        serde_json::to_string(&WorkRuntimePreparation { version: 1, purpose: "offline-work-runtime-readonly", target,
            asset_path: &asset_path, identity, sha256: &observed.sha256, bytes: observed.bytes, arap_mask: ARAP_RX, work_authority: false })
            .map_err(io::Error::other)
    }
    pub fn open(original: &FirstLoad, module: &Path, runtime: &Path) -> io::Result<Self> {
        Self::open_fixed(original, module, runtime, false)
    }
    pub fn open_cli(original: &FirstLoad, module: &Path, runtime: &Path) -> io::Result<Self> {
        Self::open_fixed(original, module, runtime, true)
    }
    fn open_fixed(original: &FirstLoad, module: &Path, runtime: &Path, compiled_cli: bool) -> io::Result<Self> {
        original.current()?;
        let artifact_name = if compiled_cli { "deepagent-code.exe" } else { "node.js" };
        if module.as_os_str().len() > 2048 || runtime.as_os_str().len() > 2048 ||
            module.file_name().and_then(|name| name.to_str()) != Some(artifact_name) ||
            (compiled_cli && runtime != module) ||
            (!compiled_cli && !matches!(runtime.file_name().and_then(|name| name.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("node.exe" | "electron.exe" | "deepagent code.exe" | "deepagent code dev.exe" | "deepagent code beta.exe"))) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let artifact = LockedPath::open(module, false, false)?;
        let fixed = LockedPath::open(&original.bootstrap_path()?.parent().ok_or(io::ErrorKind::Unsupported)?.join(artifact_name), false, false)?;
        if no_follow::identity(&artifact.file)? != no_follow::identity(&fixed.file)? { return Err(io::ErrorKind::PermissionDenied.into()); }
        let runtime = LockedPath::open(runtime, false, true)?;
        if compiled_cli && no_follow::identity(&runtime.file)? != no_follow::identity(&artifact.file)? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut header = [0u8; 64]; let mut image = runtime.file.try_clone()?; image.read_exact(&mut header)?;
        if &header[..2] != b"MZ" { return Err(io::ErrorKind::InvalidData.into()); }
        let offset = u32::from_le_bytes(header[60..64].try_into().map_err(io::Error::other)?) as u64;
        if offset > runtime.file.metadata()?.len().saturating_sub(24) { return Err(io::ErrorKind::InvalidData.into()); }
        image.seek(SeekFrom::Start(offset))?; let mut signature = [0u8; 6]; image.read_exact(&mut signature)?;
        if &signature[..4] != b"PE\0\0" || u16::from_le_bytes([signature[4], signature[5]]) != if cfg!(target_arch="aarch64") { 0xaa64 } else { 0x8664 } {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let stamps = [no_follow::stamp(&artifact.file)?, no_follow::stamp(&runtime.file)?];
        let description = serde_json::to_string(&Description { version: 1,
            purpose: if compiled_cli { "offline-cli-publisher" } else { "offline-node-publisher" },
            artifact: fingerprint(&artifact)?, runtime: fingerprint(&runtime)? })?;
        let result = Self { artifact, runtime, stamps, description, created: Instant::now() };
        result.current(original)?;
        Ok(result)
    }
    pub fn current(&self, original: &FirstLoad) -> io::Result<()> {
        original.current()?;
        if self.created.elapsed() > Duration::from_secs(30) { return Err(io::ErrorKind::TimedOut.into()); }
        for (file, stamp) in [&self.artifact, &self.runtime].iter().zip(&self.stamps) {
            file.current()?; loader::require_trusted(&file.file)?;
            if no_follow::stamp(&file.file)? != *stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
        }
        Ok(())
    }
    pub fn describe(&self, original: &FirstLoad) -> io::Result<&str> { self.current(original)?; Ok(&self.description) }
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Components { schema_version: String, target: String, source_commit: String, source_tree: String, components: Vec<Component> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Component { path: String, bytes: u64, sha256: String }
#[derive(Serialize)]
struct WorkRuntimePreparation<'a> { version: u8, purpose: &'static str, target: &'a str, asset_path: &'a str,
    identity: Identity, sha256: &'a str, bytes: u64, arap_mask: u32, work_authority: bool }
fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

struct SecurityDescriptor { raw: *mut c_void, owner: *mut c_void, dacl: *mut ACL, control: u16 }
impl Drop for SecurityDescriptor { fn drop(&mut self) { unsafe { LocalFree(self.raw); } } }
impl SecurityDescriptor {
    fn read(file: &File) -> io::Result<Self> {
        let mut owner = ptr::null_mut(); let mut dacl = ptr::null_mut(); let mut raw = ptr::null_mut();
        let code = unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner, ptr::null_mut(), &mut dacl, ptr::null_mut(), &mut raw) };
        if code != 0 { return Err(io::Error::from_raw_os_error(code as i32)); }
        let mut result = Self { raw, owner, dacl, control: 0 }; let mut revision = 0;
        if owner.is_null() || dacl.is_null() || unsafe { GetSecurityDescriptorControl(raw, &mut result.control, &mut revision) } == 0 ||
            unsafe { IsValidAcl(dacl) } == 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(result)
    }
    fn aces(&self) -> io::Result<Vec<Vec<u8>>> {
        let mut information: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetAclInformation(self.dacl, (&raw mut information).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 ||
            information.AceCount == 0 || information.AceCount > 64 { return Err(io::ErrorKind::PermissionDenied.into()); }
        (0..information.AceCount).map(|index| {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(self.dacl, index, &mut ace) } == 0 || ace.is_null() { return Err(io::ErrorKind::InvalidData.into()); }
            let size = unsafe { (*ace.cast::<ACE_HEADER>()).AceSize } as usize;
            if size < size_of::<ACE_HEADER>() || size > unsafe { (*self.dacl).AclSize } as usize { return Err(io::ErrorKind::InvalidData.into()); }
            Ok(unsafe { std::slice::from_raw_parts(ace.cast::<u8>(), size) }.to_vec())
        }).collect()
    }
}

fn grant_fixed_runtime_rx(image: &LockedPath) -> io::Result<()> {
    loader::require_trusted(&image.file)?; image.current()?;
    // The original no-delete-sharing image and ancestor leases pin this exact
    // namespace. This second handle requests WRITE_DAC only, never file data,
    // attributes, DELETE or WRITE_OWNER; FileID is checked before any mutation.
    let path = image.canonical().as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
    let handle = unsafe { CreateFileW(path.as_ptr(), 0x0016_0080, FILE_SHARE_READ, ptr::null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, 0) };
    if handle == 0 || handle == -1 { return Err(io::Error::last_os_error()); }
    let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as *mut c_void) });
    if no_follow::identity(&file)? != no_follow::identity(&image.file)? || no_follow::final_path(&file)? != image.canonical() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    loader::require_trusted(&file)?;
    let before = SecurityDescriptor::read(&file)?;
    let entries = before.aces()?;
    let mut sid = ptr::null_mut();
    if unsafe { ConvertStringSidToSidW("S-1-15-2-2".encode_utf16().chain([0]).collect::<Vec<_>>().as_ptr(), &mut sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    struct Sid(*mut c_void);
    impl Drop for Sid { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
    let sid = Sid(sid);
    let has_exact = entries.iter().any(|entry| {
        if entry.len() < offset_of!(ACCESS_ALLOWED_ACE, SidStart) + unsafe { GetLengthSid(sid.0) } as usize || entry[0] != 0 || entry[1] != 0 { return false; }
        let mask = u32::from_ne_bytes(entry[4..8].try_into().expect("bounded ACE"));
        mask == ARAP_RX && unsafe { EqualSid(entry.as_ptr().add(8).cast_mut().cast(), sid.0) } != 0
    });
    if has_exact { return Ok(()); }
    let capacity = size_of::<ACL>() + entries.iter().map(Vec::len).sum::<usize>() + offset_of!(ACCESS_ALLOWED_ACE, SidStart) + unsafe { GetLengthSid(sid.0) } as usize;
    if capacity > u16::MAX as usize || entries.len() >= 64 { return Err(io::ErrorKind::InvalidData.into()); }
    let mut storage = vec![0usize; capacity.div_ceil(size_of::<usize>())]; let changed = storage.as_mut_ptr().cast::<ACL>();
    let revision = unsafe { (*before.dacl).AclRevision } as u32;
    if unsafe { InitializeAcl(changed, capacity as u32, revision) } == 0 { return Err(io::Error::last_os_error()); }
    let insertion = entries.iter().position(|entry| entry[1] & 0x10 != 0).unwrap_or(entries.len());
    for index in 0..=entries.len() {
        if index == insertion && unsafe { AddAccessAllowedAceEx(changed, revision, 0, ARAP_RX, sid.0) } == 0 { return Err(io::Error::last_os_error()); }
        if let Some(entry) = entries.get(index) {
            if unsafe { AddAce(changed, revision, u32::MAX, entry.as_ptr().cast(), entry.len() as u32) } == 0 { return Err(io::Error::last_os_error()); }
        }
    }
    let expected = SecurityDescriptor { raw: ptr::null_mut(), owner: before.owner, dacl: changed, control: before.control }.aces()?;
    let immediate = SecurityDescriptor::read(&file)?;
    if unsafe { EqualSid(immediate.owner, before.owner) } == 0 || immediate.control != before.control || immediate.aces()? != entries {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let flags = DACL_SECURITY_INFORMATION | if before.control & SE_DACL_PROTECTED != 0 { PROTECTED_DACL_SECURITY_INFORMATION } else { UNPROTECTED_DACL_SECURITY_INFORMATION };
    let code = unsafe { SetSecurityInfo(handle, SE_FILE_OBJECT, flags, ptr::null_mut(), ptr::null_mut(), changed, ptr::null()) };
    if code != 0 { return Err(io::Error::from_raw_os_error(code as i32)); }
    let after = SecurityDescriptor::read(&file)?;
    // SetSecurityInfo converts legacy ACLs to the current inheritance model.
    // Its only permitted control change is this one-way computed marker; all
    // protection and other flags, the owner and every resulting ACE stay exact.
    if unsafe { EqualSid(after.owner, before.owner) } == 0 ||
        (after.control != before.control && after.control != before.control | SE_DACL_AUTO_INHERITED) || after.aces()? != expected {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    loader::require_trusted(&file)?; image.current()?;
    Ok(())
}
fn fingerprint(image: &LockedPath) -> io::Result<Fingerprint> {
    image.current()?; loader::require_trusted(&image.file)?;
    let length = image.file.metadata()?.len();
    if length == 0 || length > LIMIT { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut file = image.file.try_clone()?; file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new(); let mut buffer = [0u8; 65_536]; let mut bytes = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 { break; }
        bytes += read as u64;
        if bytes > length { return Err(io::ErrorKind::InvalidData.into()); }
        hash.update(&buffer[..read]);
    }
    if bytes != length { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(Fingerprint { bytes, sha256: format!("{:x}", hash.finalize()) })
}
