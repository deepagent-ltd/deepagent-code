//! Optional trusted internal Git producer. It is deliberately separate from
//! LPAC user payloads and cannot select an executable from Host input or PATH.
use super::{loader::{self, FirstLoad, WorkSystemImage}, preload::Evidence, work_factory::WorkFactory};
use crate::{native_windows::image_factory::{Image, Description, OriginalAuthority}, no_follow::LockedPath};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, collections::{BTreeMap, BTreeSet}, ffi::c_void, io::{self, Read}, path::{Path, PathBuf}, ptr};
use windows_sys::core::GUID;

#[link(name = "shell32")]
unsafe extern "system" { fn SHGetKnownFolderPath(folder: *const GUID, flags: u32, token: isize, path: *mut *mut u16) -> i32; }
#[link(name = "ole32")]
unsafe extern "system" { fn CoTaskMemFree(value: *const c_void); }
const PROGRAM_FILES: GUID = GUID { data1: 0x905e63b6, data2: 0xc1bf, data3: 0x494e,
    data4: [0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a] };

pub(super) struct Git { directory: LockedPath, image: Image, vendors: Vec<Image>, systems: Vec<WorkSystemImage>,
    system_images: Vec<Image>, description: String }
struct Original<'a> { image: &'a FirstLoad, proof: &'a Evidence, imports: RefCell<Vec<WorkSystemImage>> }
impl OriginalAuthority for Original<'_> {
    fn current(&self) -> io::Result<()> {
        self.image.current()?; self.proof.current()?;
        for image in self.imports.borrow().iter() { image.current()?; } Ok(())
    }
    fn system_images(&self) -> io::Result<Vec<Description>> {
        self.current()?; self.image.complete_work_system_imports(&mut self.imports.borrow_mut())?;
        let mut result = self.image.original_system_images()?.into_iter().map(|(path, image)|
            Description { path, identity: image.identity, bytes: image.bytes, sha256: image.sha256 }).collect::<Vec<_>>();
        for imported in self.imports.borrow().iter() {
            let (path, image) = imported.description();
            if !result.iter().any(|value| value.identity == image.identity) {
                result.push(Description { path: path.to_owned(), identity: image.identity.clone(), bytes: image.bytes, sha256: image.sha256.clone() });
            }
        } Ok(result)
    }
    fn resolve_system_import(&self, name: &str) -> io::Result<crate::protocol::Identity> {
        if let Ok(identity) = self.image.resolve_system_import(name) { return Ok(identity); }
        let imported = self.image.qualify_work_system_import(name)?; let identity = imported.description().1.identity.clone();
        let mut imports = self.imports.borrow_mut();
        if imports.len() >= 128 { return Err(io::ErrorKind::Unsupported.into()); }
        if !imports.iter().any(|value| value.description().1.identity == identity) { imports.push(imported); }
        Ok(identity)
    }
}
impl Git {
    pub(super) fn open(image: &FirstLoad, proof: &Evidence, factory: &WorkFactory) -> io::Result<Self> {
        factory.current(image, proof)?;
        let path = program_files()?.join("Git").join("mingw64").join("bin");
        let directory = phase("machine-directory-open", LockedPath::open(&path, true, false))?;
        phase("machine-directory-dacl", loader::require_machine(&directory.file))?;
        let executable = phase("machine-executable", machine_image(&path.join("git.exe")))?;
        let original = Original { image, proof, imports: RefCell::new(Vec::new()) };
        let mut pending = executable.required_imports().to_vec();
        let mut selected = BTreeSet::new(); let mut vendors = BTreeMap::<String, Image>::new();
        while let Some(name) = pending.pop() {
            if !selected.insert(name.clone()) { continue; }
            if selected.len() > 128 { return Err(io::ErrorKind::Unsupported.into()); }
            // PreferSystem32 is part of this fixed-purpose launch contract.
            // All vendor alternatives must be the exact machine-owned leaf in
            // the same immutable installation directory; search paths are absent.
            if original.resolve_system_import(&name).is_ok() { continue; }
            let imported = phase("machine-vendor", machine_image(&path.join(&name)))?;
            pending.extend(imported.required_imports().iter().cloned());
            vendors.insert(name, imported);
        }
        let system_images = phase("system-descriptions", original.system_images())?.into_iter().map(Image::open_original_system).collect::<io::Result<Vec<_>>>()
            .map_err(|error|capture_failure("system-images",error))?;
        let vendors = vendors.into_values().collect::<Vec<_>>();
        let all = std::iter::once(&executable).chain(vendors.iter()).chain(system_images.iter());
        let mut hash = Sha256::new(); hash.update(b"dac.windows.fixed-event-git-images.v1\0");
        let mut bytes = 0u64; let mut identities = BTreeSet::new(); let mut published = Vec::new();
        for value in all {
            let value = value.description();
            bytes = bytes.checked_add(value.bytes).filter(|value| *value <= 536_870_912).ok_or(io::ErrorKind::InvalidData)?;
            if !identities.insert(format!("{:?}", value.identity)) { return Err(io::ErrorKind::InvalidData.into()); }
            hash.update(format!("{:?}\0{}\0{}\0", value.identity, value.bytes, value.sha256).as_bytes());
            published.push(serde_json::json!({"basename":value.path.file_name().and_then(|value|value.to_str()).ok_or(io::ErrorKind::InvalidData)?,
                "identity":value.identity,"bytes":value.bytes,"sha256":value.sha256}));
        }
        let description = serde_json::to_string(&serde_json::json!({"version":1,"purpose":"fixed-event-git-plumbing",
            "filename":path.join("git.exe"),"sha256":executable.description().sha256,"closure_hash":format!("{:x}",hash.finalize()),
            "images":published,"isolation":"trusted-internal-producer-original-user","work_authority":false}))?;
        let result = Self { directory, image: executable, vendors, systems: original.imports.into_inner(), system_images, description };
        phase("git-current", result.current())?; phase("factory-current", factory.current(image, proof))?; Ok(result)
    }
    pub(super) fn current(&self) -> io::Result<()> {
        self.directory.current()?; loader::require_machine(&self.directory.file)?;
        for image in std::iter::once(&self.image).chain(self.vendors.iter()).chain(self.system_images.iter()) {
            image.current()?; loader::require_machine(image.file())?;
        }
        for image in &self.systems { image.current()?; } Ok(())
    }
    pub(super) fn describe(&self) -> io::Result<&str> { self.current()?; Ok(&self.description) }
    pub(super) fn image(&self) -> &Image { &self.image }
}
fn phase<A>(stage:&'static str,result:io::Result<A>)->io::Result<A>{result.map_err(|error|capture_failure(stage,error))}
fn capture_failure(stage:&'static str,error:io::Error)->io::Error{eprintln!("WINDOWS_EVENT_GIT_CAPTURE_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));error}
fn machine_image(path: &Path) -> io::Result<Image> {
    let held = LockedPath::open_original_git_image(path)?; loader::require_machine(&held.file)?;
    let size = held.file.metadata()?.len();
    if size == 0 || size > 134_217_728 { return Err(io::ErrorKind::InvalidData.into()); }
    let mut bytes = Vec::new(); held.file.try_clone()?.take(size + 1).read_to_end(&mut bytes)?;
    held.current()?; loader::require_machine(&held.file)?;
    if bytes.len() as u64 != size { return Err(io::ErrorKind::InvalidData.into()); }
    Image::open_original_git(Description { path: path.to_owned(), identity: crate::no_follow::identity(&held.file)?,
        bytes: size, sha256: format!("{:x}", Sha256::digest(&bytes)) },loader::require_machine)
}
fn program_files() -> io::Result<PathBuf> {
    let mut value = ptr::null_mut();
    let code = unsafe { SHGetKnownFolderPath(&PROGRAM_FILES, 0, 0, &mut value) };
    if code != 0 || value.is_null() { return Err(io::ErrorKind::Unsupported.into()); }
    let result = (|| -> io::Result<PathBuf> {
        let mut length = 0;
        while length <= 2048 && unsafe { *value.add(length) } != 0 { length += 1; }
        if length == 0 || length > 2048 { return Err(io::ErrorKind::InvalidData.into()); }
        let value = String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) }).map_err(|_| io::ErrorKind::InvalidData)?;
        let path = PathBuf::from(value);
        if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::CurDir | std::path::Component::ParentDir)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        } Ok(path)
    })();
    unsafe { CoTaskMemFree(value.cast()); } result
}
