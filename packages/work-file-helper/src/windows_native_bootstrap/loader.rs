use crate::{no_follow::{self, LockedPath}, protocol::Identity};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{ffi::{c_void, OsString}, fs::File, io::{self, Read}, mem::size_of,
    os::windows::{ffi::OsStringExt, io::AsRawHandle}, path::PathBuf, ptr};
use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE},
    Security::{ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
        GetAce, GetAclInformation, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER, EqualSid, OWNER_SECURITY_INFORMATION, Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT}},
    System::{Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, Module32NextW, TH32CS_SNAPMODULE},
        Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcessToken}}};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleExW(flags: u32, name: *const u16, module: *mut isize) -> i32;
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn K32GetMappedFileNameW(process: HANDLE, address: *const c_void, name: *mut u16, bytes: u32) -> u32;
    fn GetLogicalDrives() -> u32;
    fn QueryDosDeviceW(name: *const u16, target: *mut u16, bytes: u32) -> u32;
    fn GetSystemDirectoryW(name: *mut u16, bytes: u32) -> u32;
    fn FreeLibrary(module: isize) -> i32;
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
}

#[derive(Clone, Serialize)]
pub struct ImageDescription { pub path: PathBuf, pub identity: Identity, pub bytes: u64, pub sha256: String, pub system: bool }
#[derive(Serialize)]
pub struct Description { pub version: u8, pub target: &'static str, pub bootstrap: ImageDescription,
    pub host: ImageDescription, pub libraries: Vec<ImageDescription>, pub closure_hash: String,
    pub mapping_exclusion: &'static str, pub work_authority: bool }
struct Module(isize);
impl Drop for Module { fn drop(&mut self) { unsafe { FreeLibrary(self.0); } } }
struct Image { module: Module, path: LockedPath, observed: PathBuf, stamp: String, description: ImageDescription }
pub struct WorkSystemImage { image: Image }
impl WorkSystemImage {
    pub fn description(&self)->(&std::path::Path,&ImageDescription){(&self.image.observed,&self.image.description)}
    pub fn current(&self)->io::Result<()>{
        self.image.path.current()?;require_machine(&self.image.path.file)?;
        if module_path(self.image.module.0)?!=self.image.observed || no_follow::stamp(&self.image.path.file)?!=self.image.stamp{return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
    }
}
pub struct FirstLoad { images: Vec<Image>, system: LockedPath, description: Description }

impl FirstLoad {
    pub fn capture(address: *const c_void) -> io::Result<Self> {
        // FROM_ADDRESS obtains a real original loader reference. It is neither
        // a filename lookup nor UNCHANGED_REFCOUNT; every reference stays owned.
        let own = module(address)?;
        let system_name = system_path()?;
        let system = LockedPath::open(&system_name, true, false).map_err(|error| diagnostic(error, "system-root-lease", None))?;
        require_machine(&system.file).map_err(|error| diagnostic(error, "system-root-dacl", None))?;
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId()) };
        if snapshot == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
        let snapshot = Snapshot(snapshot);
        let mut entry: MODULEENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = size_of::<MODULEENTRY32W>() as u32;
        if unsafe { Module32FirstW(snapshot.0, &mut entry) } == 0 { return Err(io::Error::last_os_error()); }
        let mut images = Vec::new();
        loop {
            if images.len() >= 128 { return Err(io::ErrorKind::Unsupported.into()); }
            let held = module(entry.modBaseAddr.cast())?;
            let path = module_path(held.0)?;
            let is_system = path.parent().zip(system_name.to_str()).is_some_and(|(parent, name)|
                parent.to_str().is_some_and(|parent| parent.eq_ignore_ascii_case(name)));
            let locked = (if is_system { LockedPath::open_system_image(&path) } else { LockedPath::open(&path, false, true) })
                .map_err(|error| diagnostic(error, "module-lease", path.file_name().and_then(|name| name.to_str())))?;
            if is_system {
                if locked.canonical().parent() != Some(system.canonical()) { return Err(io::ErrorKind::PermissionDenied.into()); }
                require_machine(&locked.file).map_err(|error| diagnostic(error, "module-dacl", path.file_name().and_then(|name| name.to_str())))?;
            }
            if !is_system { require_trusted(&locked.file).map_err(|error| diagnostic(error, "module-private-dacl", path.file_name().and_then(|name| name.to_str())))?; }
            let stamp = no_follow::stamp(&locked.file)?;
            let bytes = locked.file.metadata()?.len();
            if bytes == 0 || bytes > 268_435_456 || images.iter().map(|image: &Image| image.description.bytes).sum::<u64>() + bytes > 536_870_912 {
                return Err(io::ErrorKind::Unsupported.into());
            }
            let mut hash = Sha256::new();
            if io::copy(&mut locked.file.try_clone()?.take(bytes + 1), &mut hash)? != bytes { return Err(io::ErrorKind::InvalidData.into()); }
            if no_follow::stamp(&locked.file)? != stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
            let description = ImageDescription { path: locked.canonical().to_owned(), identity: no_follow::identity(&locked.file)?,
                bytes, sha256: format!("{:x}", hash.finalize()), system: is_system };
            images.push(Image { module: held, path: locked, observed: path, stamp, description });
            if unsafe { Module32NextW(snapshot.0, &mut entry) } == 0 {
                if io::Error::last_os_error().raw_os_error() != Some(18) { return Err(io::Error::last_os_error()); }
                break;
            }
        }
        let own_index = images.iter().position(|image| image.module.0 == own.0).ok_or(io::ErrorKind::PermissionDenied)?;
        let host_index = images.iter().position(|image| module_path(image.module.0).ok() == module_path(0).ok()).ok_or(io::ErrorKind::PermissionDenied)?;
        let mut hash = Sha256::new();
        hash.update(b"dac.windows-native-first-load.v1\0");
        for image in &images { hash.update(serde_json::to_vec(&image.description)?); hash.update([0]); }
        let description = Description { version: 1, target: if cfg!(target_arch = "aarch64") { "win32-arm64" } else { "win32-x64" },
            bootstrap: images[own_index].description.clone(), host: images[host_index].description.clone(),
            libraries: images.iter().enumerate().filter(|(index, _)| *index != own_index && *index != host_index)
                .map(|(_, image)| image.description.clone()).collect(), closure_hash: format!("{:x}", hash.finalize()),
            mapping_exclusion: "original-read-share-only", work_authority: false };
        let result = Self { images, system, description };
        result.current().map_err(|error| diagnostic(error, "original-current", None))?;
        Ok(result)
    }
    pub fn description(&self) -> &Description { &self.description }
    pub fn bootstrap_path(&self) -> io::Result<&std::path::Path> {
        self.images.iter().find(|image| image.description.identity == self.description.bootstrap.identity)
            .map(|image| image.observed.as_path()).ok_or_else(|| io::ErrorKind::PermissionDenied.into())
    }
    /// Only the original loader's machine-owned System32 objects qualify.
    /// API-set names resolve through the OS's already-loaded original module;
    /// this never searches a caller directory or loads an unheld DLL.
    pub fn resolve_system_import(&self, name: &str) -> io::Result<Identity> {
        self.current()?;
        if name.len() > 256 || !name.ends_with(".dll") ||
            !name.bytes().all(|value| value.is_ascii_alphanumeric() || b"-_.".contains(&value)) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let wide = name.encode_utf16().chain([0]).collect::<Vec<_>>();
        let loaded = unsafe { GetModuleHandleW(wide.as_ptr()) };
        self.images.iter().find(|image| image.module.0 == loaded && image.description.system)
            .map(|image| image.description.identity.clone()).ok_or_else(|| io::ErrorKind::Unsupported.into())
    }
    /// The original preloaded factory invokes this only for bounded import
    /// names read from its publisher-attested, already-held fixed PE images.
    /// Normal DLL bytes are held before LoadLibrary; API-set aliases can only
    /// resolve to an original or machine-owned System32 OS module.
    pub fn qualify_work_system_import(&self,name:&str)->io::Result<WorkSystemImage>{
        self.current()?;
        if name.len()>256 || !name.ends_with(".dll") || !name.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"-_.".contains(&byte)){
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let system_name=system_path()?;
        let system=LockedPath::open(&system_name,true,false)?;
        if no_follow::identity(&system.file)?!=no_follow::identity(&self.system.file)?{return Err(io::ErrorKind::PermissionDenied.into());}
        require_machine(&system.file)?;
        let api_set=name.starts_with("api-ms-")||name.starts_with("ext-ms-");
        let candidate=if api_set{None}else{
            let image=LockedPath::open_system_image(&system_name.join(name))?;require_machine(&image.file)?;Some(image)
        };
        use std::os::windows::ffi::OsStrExt;
        let requested=if api_set{PathBuf::from(name)}else{system_name.join(name)};
        let requested=requested.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
        let loaded=unsafe{LoadLibraryExW(requested.as_ptr(),0,0x800)}; // LOAD_LIBRARY_SEARCH_SYSTEM32
        if loaded==0{return Err(io::Error::last_os_error());}
        let held=Module(loaded);let observed=module_path(loaded)?;
        let path=LockedPath::open_system_image(&observed)?;
        if path.canonical().parent()!=Some(self.system.canonical()){return Err(io::ErrorKind::PermissionDenied.into());}
        require_machine(&path.file)?;
        if let Some(candidate)=candidate{
            candidate.current()?;
            if no_follow::identity(&candidate.file)?!=no_follow::identity(&path.file)? || candidate.canonical()!=path.canonical(){return Err(io::ErrorKind::PermissionDenied.into());}
        }
        let stamp=no_follow::stamp(&path.file)?;let bytes=path.file.metadata()?.len();
        if bytes==0 || bytes>268_435_456{return Err(io::ErrorKind::Unsupported.into());}
        let mut hash=Sha256::new();if io::copy(&mut path.file.try_clone()?.take(bytes+1),&mut hash)?!=bytes{return Err(io::ErrorKind::InvalidData.into());}
        let description=ImageDescription{path:path.canonical().to_owned(),identity:no_follow::identity(&path.file)?,bytes,sha256:format!("{:x}",hash.finalize()),system:true};
        let result=WorkSystemImage{image:Image{module:held,path,observed,stamp,description}};
        result.current()?;self.current()?;Ok(result)
    }
    pub fn complete_work_system_imports(&self,imports:&mut Vec<WorkSystemImage>)->io::Result<()>{
        self.current()?;let system=system_path()?;
        let snapshot=Snapshot(unsafe{CreateToolhelp32Snapshot(TH32CS_SNAPMODULE,GetCurrentProcessId())});
        if snapshot.0==INVALID_HANDLE_VALUE{return Err(io::Error::last_os_error());}
        let mut entry:MODULEENTRY32W=unsafe{std::mem::zeroed()};entry.dwSize=size_of::<MODULEENTRY32W>() as u32;
        if unsafe{Module32FirstW(snapshot.0,&mut entry)}==0{return Err(io::Error::last_os_error());}
        loop{
            let loaded=module(entry.modBaseAddr.cast())?;let path=module_path(loaded.0)?;
            if path.parent().zip(system.to_str()).is_some_and(|(path,system)|path.to_str().is_some_and(|path|path.eq_ignore_ascii_case(system)))&&
                !self.images.iter().any(|image|image.module.0==loaded.0)&&!imports.iter().any(|image|image.image.module.0==loaded.0){
                if imports.len()>=128{return Err(io::ErrorKind::Unsupported.into());}
                let name=path.file_name().and_then(|name|name.to_str()).ok_or(io::ErrorKind::InvalidData)?.to_ascii_lowercase();
                imports.push(self.qualify_work_system_import(&name)?);
            }
            if unsafe{Module32NextW(snapshot.0,&mut entry)}==0{
                if io::Error::last_os_error().raw_os_error()!=Some(18){return Err(io::Error::last_os_error());}break;
            }
        }
        self.current()?;for image in imports{image.current()?;}Ok(())
    }
    pub fn original_windows_root(&self) -> io::Result<(PathBuf,LockedPath)> {
        self.current()?;
        let system_name=system_path()?;
        let system=LockedPath::open(&system_name,true,false)?;
        if no_follow::identity(&system.file)?!=no_follow::identity(&self.system.file)? { return Err(io::ErrorKind::PermissionDenied.into()); }
        require_machine(&system.file)?;
        let name=system_name.parent().ok_or(io::ErrorKind::InvalidData)?.to_owned();
        let held=LockedPath::open(&name,true,false)?;
        require_machine(&held.file)?; held.current()?; self.current()?;
        Ok((name,held))
    }
    pub fn original_system_images(&self) -> io::Result<Vec<(PathBuf, ImageDescription)>> {
        self.current()?;
        Ok(self.images.iter().filter(|image| image.description.system)
            .map(|image| (image.observed.clone(), image.description.clone())).collect())
    }
    pub fn original_host_file(&self) -> io::Result<&File> {
        self.images.iter().find(|image| image.description.identity == self.description.host.identity)
            .map(|image| &image.path.file).ok_or_else(|| io::ErrorKind::PermissionDenied.into())
    }
    pub fn current(&self) -> io::Result<()> {
        self.system.current()?;
        require_machine(&self.system.file)?;
        for image in &self.images {
            image.path.current()?;
            let name = module_path(image.module.0)?;
            // The original no-follow ancestor handles still deny WRITE/DELETE.
            // Match the actual mapped image to that held namespace rather than
            // acquiring a second copy of its entire immutable directory chain.
            if name != image.observed || no_follow::stamp(&image.path.file)? != image.stamp ||
                no_follow::identity(&image.path.file)? != image.description.identity {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            if image.description.system { require_machine(&image.path.file)?; }
            if !image.description.system { require_trusted(&image.path.file)?; }
        }
        Ok(())
    }
}

struct Snapshot(HANDLE);
impl Drop for Snapshot { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
fn module(address: *const c_void) -> io::Result<Module> {
    let mut handle = 0;
    if address.is_null() || unsafe { GetModuleHandleExW(4, address.cast(), &mut handle) } == 0 || handle == 0 { return Err(io::Error::last_os_error()); }
    Ok(Module(handle))
}
fn module_path(handle: isize) -> io::Result<PathBuf> {
    let address = if handle == 0 { unsafe { GetModuleHandleW(ptr::null()) } } else { handle };
    if address == 0 { return Err(io::Error::last_os_error()); }
    let mut text = vec![0u16; 2049];
    // The original loader reference identifies the mapped image itself. Its
    // Win32 load-name can contain a Bun junction, so never turn that alias into
    // a general filesystem exception or use an arbitrary caller path.
    let bytes = unsafe { K32GetMappedFileNameW(GetCurrentProcess(), address as *const c_void, text.as_mut_ptr(), text.len() as u32) };
    if bytes == 0 || bytes as usize >= text.len() { return Err(io::ErrorKind::InvalidData.into()); }
    device_path(&String::from_utf16(&text[..bytes as usize]).map_err(io::Error::other)?)
}
/// Only a kernel-observed actual image device name reaches this conversion.
/// SUBST, network/device aliases, mount roots and user-selected paths are not
/// accepted; the returned drive chain still gets original no-follow leases.
pub fn device_path(name: &str) -> io::Result<PathBuf> {
    let devices = unsafe { GetLogicalDrives() };
    if devices == 0 || name.len() > 2048 || !name.starts_with("\\Device\\HarddiskVolume") { return Err(io::ErrorKind::Unsupported.into()); }
    for index in 0..26 {
        if devices & (1 << index) == 0 { continue; }
        let drive = [b'A' as u16 + index as u16, b':' as u16, 0];
        let mut target = vec![0u16; 2049];
        let size = unsafe { QueryDosDeviceW(drive.as_ptr(), target.as_mut_ptr(), target.len() as u32) };
        if size == 0 { continue; }
        if size as usize >= target.len() { return Err(io::ErrorKind::Unsupported.into()); }
        let length = target.iter().position(|unit| *unit == 0).ok_or(io::ErrorKind::InvalidData)?;
        let target = String::from_utf16(&target[..length]).map_err(io::Error::other)?;
        let Some(volume) = target.strip_prefix("\\Device\\HarddiskVolume") else { continue; };
        if volume.is_empty() || !volume.bytes().all(|byte| byte.is_ascii_digit()) { continue; }
        if name.len() > target.len() && name.as_bytes()[target.len()] == b'\\' && name[..target.len()].eq_ignore_ascii_case(&target) {
            return Ok(PathBuf::from(format!("{}:{}", (b'A' + index as u8) as char, &name[target.len()..])));
        }
    }
    Err(io::ErrorKind::Unsupported.into())
}
fn system_path() -> io::Result<PathBuf> {
    let mut text = vec![0u16; 2049];
    let bytes = unsafe { GetSystemDirectoryW(text.as_mut_ptr(), text.len() as u32) };
    if bytes == 0 || bytes as usize >= text.len() { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(OsString::from_wide(&text[..bytes as usize]).into())
}

fn machine_sid(sid: *mut c_void) -> io::Result<bool> {
    if sid.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 { return Err(io::Error::last_os_error()); }
    let mut length = 0;
    while length < 256 && unsafe { *text.add(length) } != 0 { length += 1; }
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(io::Error::other);
    unsafe { LocalFree(text.cast()); }
    let text = result?;
    Ok(matches!(text.as_str(), "S-1-5-18" | "S-1-5-32-544" |
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"))
}
pub(super) fn require_machine(file: &File) -> io::Result<()> {
    let mut owner = ptr::null_mut(); let mut dacl = ptr::null_mut(); let mut descriptor = ptr::null_mut();
    let result = unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &mut owner, ptr::null_mut(), &mut dacl, ptr::null_mut(), &mut descriptor) };
    if result != 0 { return Err(io::Error::from_raw_os_error(result as i32)); }
    let descriptor = Descriptor(descriptor);
    if !machine_sid(owner)? || dacl.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut information: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetAclInformation(dacl, (&raw mut information).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 ||
        information.AceCount == 0 || information.AceCount > 64 { return Err(io::ErrorKind::PermissionDenied.into()); }
    for index in 0..information.AceCount {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Header.AceType == 1 { continue; }
        if ace.Header.AceType != 0 { return Err(io::ErrorKind::Unsupported.into()); }
        // Ignore an inherit-only ACE for this object; all ancestor names remain
        // original no-delete-sharing handles for the complete native lifetime.
        if ace.Header.AceFlags & 8 == 0 && ace.Mask & 0x500d_0156 != 0 && !machine_sid((&raw const ace.SidStart).cast_mut().cast())? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    drop(descriptor);
    Ok(())
}

/// Installed user-local images may be owned/writable by this current operator
/// or machine principals. A broad Users/Everyone writable image is rejected;
/// read-only sharing still excludes old mapped writers for the entire lifetime.
pub fn require_trusted(file: &File) -> io::Result<()> {
    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 { return Err(io::Error::last_os_error()); }
    let token = Snapshot(token); let mut length = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length); }
    if length == 0 || length > 65_536 { return Err(io::ErrorKind::InvalidData.into()); }
    let mut user = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token.0, TokenUser, user.as_mut_ptr().cast(), length, &mut length) } == 0 { return Err(io::Error::last_os_error()); }
    let user = unsafe { &*user.as_ptr().cast::<TOKEN_USER>() };
    let trusted = |sid: *mut c_void| -> io::Result<bool> {
        Ok(!sid.is_null() && (unsafe { EqualSid(sid, user.User.Sid) } != 0 || machine_sid(sid)?))
    };
    let mut owner = ptr::null_mut(); let mut dacl = ptr::null_mut(); let mut descriptor = ptr::null_mut();
    let result = unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &mut owner, ptr::null_mut(), &mut dacl, ptr::null_mut(), &mut descriptor) };
    if result != 0 { return Err(io::Error::from_raw_os_error(result as i32)); }
    let descriptor = Descriptor(descriptor);
    if !trusted(owner)? || dacl.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut information: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetAclInformation(dacl, (&raw mut information).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 ||
        information.AceCount == 0 || information.AceCount > 64 { return Err(io::ErrorKind::PermissionDenied.into()); }
    for index in 0..information.AceCount {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Header.AceType == 1 { continue; }
        if ace.Header.AceType != 0 { return Err(io::ErrorKind::Unsupported.into()); }
        if ace.Header.AceFlags & 8 == 0 && ace.Mask & 0x500d_0156 != 0 && !trusted((&raw const ace.SidStart).cast_mut().cast())? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    drop(descriptor); Ok(())
}

struct Descriptor(*mut c_void);
impl Drop for Descriptor { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }

fn diagnostic(error: io::Error, phase: &'static str, name: Option<&str>) -> io::Error {
    // Operator diagnosis is bounded to a native phase and an ASCII image
    // basename. No ancestor path, environment, request or credential is logged.
    let name = name.filter(|name| name.len() <= 128 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))).unwrap_or("image");
    eprintln!("dac-native-first-load:{phase}:{name}:{:?}:{:?}", error.kind(), error.raw_os_error());
    error
}
