//! Native image leases precede CreateProcess. This is not an executable launcher
//! that an ordinary Host spawn may invoke to repair an already-loaded image.
//! The production entry must be a trusted, registered in-process native factory.
use crate::{no_follow::{self, LockedPath}, protocol::Identity};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read, Seek, SeekFrom}, os::windows::io::AsRawHandle, path::Path, ptr};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE},
    System::Memory::{CreateFileMappingW, PAGE_READONLY, SEC_IMAGE},
    System::Threading::{CreateProcessW, GetCurrentProcess, GetCurrentProcessId, QueryFullProcessImageNameW, TerminateProcess,
        WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOW, CREATE_SUSPENDED, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT}};

#[derive(Clone)]
pub struct Description { pub path: std::path::PathBuf, pub identity: Identity, pub sha256: String, pub bytes: u64 }
struct Section(HANDLE);
impl Drop for Section { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
pub struct Image { path: LockedPath, section: Section, description: Description, stamp: String, imports: Vec<String>, git_links: Option<(u32,fn(&File)->io::Result<()>)>,
    original_system: bool, system_machine: Option<fn(&File)->io::Result<()>> }
pub struct Factory { supervisor: Image, payload: Image, closure: Vec<Image>, closure_hash: String }
pub struct Suspended<'a> { image: &'a Image, process: PROCESS_INFORMATION }

impl Image {
    pub fn open(expected: Description) -> io::Result<Self> {
        Self::open_image(expected, false, None, None)
    }
    pub(crate) fn open_original_system(expected: Description) -> io::Result<Self> { Self::open_image(expected, true, None, None) }
    pub(crate) fn open_original_git(expected: Description, machine:fn(&File)->io::Result<()>) -> io::Result<Self> { Self::open_image(expected, false, Some(machine), None) }
    fn open_image(expected: Description, original_system: bool, original_git: Option<fn(&File)->io::Result<()>>,
        system_machine: Option<fn(&File)->io::Result<()>>) -> io::Result<Self> {
        if expected.bytes == 0 || expected.bytes > 268_435_456 || expected.sha256.len() != 64 ||
            !expected.sha256.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // The System32 exception is reachable only from the original
        // preloaded authority below. Ordinary work files stay single-link.
        let path = if original_git.is_some() { LockedPath::open_original_git_image(&expected.path)? }
            else if original_system { LockedPath::open_system_image(&expected.path)? }
            else { LockedPath::open(&expected.path, false, true)? };
        let git_links = if let Some(machine)=original_git {
            machine(&path.file)?;
            Some((image_links(&path.file)?,machine))
        } else { None };
        let stamp = no_follow::stamp(&path.file)?;
        if no_follow::identity(&path.file)? != expected.identity || path.file.metadata()?.len() != expected.bytes {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut content = Vec::new();
        path.file.try_clone()?.take(expected.bytes + 1).read_to_end(&mut content)?;
        if content.len() as u64 != expected.bytes || format!("{:x}", Sha256::digest(&content)) != expected.sha256 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let imports = if original_system { Vec::new() } else { imports(&content)? };
        // NtCreateFile without FILE_SHARE_WRITE rejects existing writable file
        // mappings as well as writer handles, including a surviving mapped view
        // whose original handle has closed. Keep that original lease throughout
        // the unnamed image section lifetime; SEC_IMAGE alone is not the proof.
        let section = Section(unsafe { CreateFileMappingW(path.file.as_raw_handle() as HANDLE, ptr::null(),
            PAGE_READONLY | SEC_IMAGE, 0, 0, ptr::null()) });
        if section.0 == 0 { return Err(io::Error::last_os_error()); }
        if no_follow::stamp(&path.file)? != stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
        let result = Self { path, section, description: expected, stamp, imports, git_links, original_system,
            system_machine: if original_system { system_machine } else { None } };
        result.current()?;
        Ok(result)
    }
    pub fn description(&self) -> &Description { &self.description }
    pub(crate) fn file(&self) -> &File { &self.path.file }
    pub(crate) fn required_imports(&self) -> &[String] { &self.imports }
    pub fn current(&self) -> io::Result<()> {
        self.current_role(if self.original_system { "system-library" } else { "private-image" })
    }
    fn current_role(&self, role: &'static str) -> io::Result<()> {
        image_checked(role,"lease",self.path.current())?;
        if let Some((links,machine))=self.git_links {
            image_checked(role,"git-machine",machine(&self.path.file))?;
            if image_changed(role,"git-links-match",image_checked(role,"git-links-read",image_links(&self.path.file))?!=links){return Err(io::ErrorKind::PermissionDenied.into());}
        }
        if image_changed(role,"section",self.section.0 == 0) ||
            image_changed(role,"stamp-match",image_stamp_changed(self,role,image_checked(role,"stamp-read",no_follow::stamp(&self.path.file))?)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
    pub fn verify_process(&self, process: HANDLE) -> io::Result<()> {
        let mut name = vec![0u16; 2049];
        let mut count = name.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, name.as_mut_ptr(), &mut count) } == 0 || count == 0 || count as usize >= name.len() {
            return Err(io::Error::last_os_error());
        }
        use std::os::windows::ffi::OsStringExt;
        let observed_name=std::ffi::OsString::from_wide(&name[..count as usize]);
        let observed = if self.git_links.is_some(){LockedPath::open_original_git_image(Path::new(&observed_name))?}
            else{LockedPath::open(Path::new(&observed_name), false, true)?};
        if let Some((links,machine))=self.git_links {
            machine(&observed.file)?;
            if image_links(&observed.file)?!=links{return Err(io::ErrorKind::PermissionDenied.into());}
        }
        if no_follow::identity(&observed.file)? != self.description.identity || observed.canonical() != self.path.canonical() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut bytes = observed.file.try_clone()?;
        bytes.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        if io::copy(&mut bytes.take(self.description.bytes + 1), &mut digest)? != self.description.bytes ||
            format!("{:x}", digest.finalize()) != self.description.sha256 { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.current()
    }
    fn suspended(&self, argv: &[String]) -> io::Result<Suspended<'_>> {
        self.current()?;
        if argv.len() > 64 || argv.iter().any(|value| value.len() > 2048 || value.contains('\0')) { return Err(io::ErrorKind::InvalidInput.into()); }
        let application = self.path.canonical().as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
        use std::os::windows::ffi::OsStrExt;
        let mut command = std::iter::once(self.path.canonical().to_str().ok_or(io::ErrorKind::InvalidData)?.to_owned())
            .chain(argv.iter().cloned()).map(|value| quote(&value)).collect::<Vec<_>>().join(" ").encode_utf16().chain([0]).collect::<Vec<_>>();
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let environment = [0u16, 0];
        if unsafe { CreateProcessW(application.as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(), 0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, environment.as_ptr().cast(), ptr::null(), &startup, &mut process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let created = Suspended { image: self, process };
        created.image.verify_process(created.process.hProcess)?;
        Ok(created)
    }
}

fn image_diagnostic(role: &'static str, stage: &'static str, field: &'static str, error: &io::Error) {
    eprintln!("WINDOWS_IMAGE_CURRENT role={role} stage={stage} field={field} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));
}
fn image_checked<A>(role: &'static str, stage: &'static str, value: io::Result<A>) -> io::Result<A> {
    value.inspect_err(|error|image_diagnostic(role,stage,"none",error))
}
fn image_changed(role: &'static str, stage: &'static str, changed: bool) -> bool {
    if changed { image_diagnostic(role,stage,"none",&io::ErrorKind::PermissionDenied.into()); }
    changed
}
fn image_stamp_changed(image: &Image, role: &'static str, actual: String) -> bool {
    if image_stamp_valid(image,&actual) { return false; }
    image_stamp(image,role,actual) != image.stamp
}
fn image_stamp_valid(image: &Image, actual: &str) -> bool {
    if actual == image.stamp { return true; }
    if !image.original_system || image.git_links.is_some() { return false; }
    let Some(machine) = image.system_machine else { return false; };
    let left = actual.rsplitn(8, ':').collect::<Vec<_>>();
    let right = image.stamp.rsplitn(8, ':').collect::<Vec<_>>();
    // Only an original system image can re-prove a metadata-only update with
    // its held bytes and sealed policy. Captured descriptions stay immutable.
    left.len() == 8 && right.len() == 8 && left[4] != right[4]
        && (0..8).all(|index|index == 4 || left[index] == right[index])
        && image_content_same(image,actual).unwrap_or(false)
        && machine(&image.path.file).is_ok()
        && no_follow::stamp(&image.path.file).is_ok_and(|stamp|stamp == actual)
}
fn image_stamp(image: &Image, role: &'static str, actual: String) -> String {
    if actual != image.stamp {
        let left = actual.rsplitn(8, ':').collect::<Vec<_>>();
        let right = image.stamp.rsplitn(8, ':').collect::<Vec<_>>();
        if left.len() == 8 && right.len() == 8 {
            for (index,field) in ["links","size-low","size-high","attrs","change","write","creation","identity"].into_iter().enumerate() {
                if left[index] != right[index] { image_diagnostic(role,"stamp-match",field,&io::ErrorKind::PermissionDenied.into()); }
            }
            if image.original_system && left[4] != right[4] && (0..8).all(|index|index == 4 || left[index] == right[index]) {
                let content = image_content_same(image,&actual);
                let machine = image.system_machine.map(|policy|policy(&image.path.file));
                let stable = no_follow::stamp(&image.path.file).is_ok_and(|stamp|stamp == actual);
                let content = match (stable,content) { (true,Ok(true)) => "true", (true,Ok(false)) => "false", _ => "unknown" };
                let machine = match (stable,machine) {
                    (true,Some(Ok(()))) => "true",
                    (true,Some(Err(error))) if error.kind() == io::ErrorKind::PermissionDenied && error.raw_os_error().is_none() => "false",
                    _ => "unknown",
                };
                let name = image.description.path.file_name().and_then(|name|name.to_str())
                    .filter(|name|!name.is_empty() && name.len() <= 128 && name.bytes().all(|byte|byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))
                    .unwrap_or("system-image");
                eprintln!("WINDOWS_IMAGE_CHANGE_ONLY role={role} image={name} content_same={content} machine_trusted={machine}");
            }
        }
    }
    actual
}
fn image_content_same(image: &Image, observed: &str) -> io::Result<bool> {
    if image.description.bytes == 0 || image.description.bytes > 268_435_456 || no_follow::stamp(&image.path.file)? != observed {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    let mut reader = image.path.file.try_clone()?;
    let position = reader.stream_position()?;
    let mut hash = Sha256::new();
    let read = (|| {
        reader.seek(SeekFrom::Start(0))?;
        io::copy(&mut (&mut reader).take(image.description.bytes + 1),&mut hash)
    })();
    let restored = reader.seek(SeekFrom::Start(position));
    let bytes = read?;
    restored?;
    if no_follow::stamp(&image.path.file)? != observed { return Err(io::ErrorKind::WouldBlock.into()); }
    Ok(bytes == image.description.bytes && format!("{:x}",hash.finalize()) == image.description.sha256)
}

/// Implemented only by the fixed in-process first-loader owner. A public
/// descriptor constructor cannot obtain its original token or OS resolution.
pub(crate) trait OriginalAuthority {
    fn current(&self) -> io::Result<()>;
    fn system_images(&self) -> io::Result<Vec<Description>>;
    fn resolve_system_import(&self, name: &str) -> io::Result<Identity>;
    // Reuse a fixed owner's policy only for refused-image diagnostics.
    fn system_machine(&self) -> Option<fn(&File)->io::Result<()>> { None }
}

impl Factory {
    pub fn open(supervisor: Description, payload: Description, closure: Vec<Description>) -> io::Result<Self> {
        if closure.len() > 128 || supervisor.identity == payload.identity ||
            closure.iter().try_fold(supervisor.bytes.checked_add(payload.bytes).ok_or(io::ErrorKind::InvalidInput)?, |total, value|
                total.checked_add(value.bytes).ok_or(io::ErrorKind::InvalidInput))? > 536_870_912 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let supervisor = Image::open(supervisor)?;
        let payload = Image::open(payload)?;
        let closure = closure.into_iter().map(Image::open).collect::<io::Result<Vec<_>>>()?;
        let names = closure.iter().map(|image| image.description.path.file_name().and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))).collect::<io::Result<std::collections::BTreeSet<_>>>()?;
        if names.len() != closure.len() || std::iter::once(&supervisor).chain(std::iter::once(&payload)).chain(closure.iter())
            .flat_map(|image| image.imports.iter()).any(|name| !names.contains(name)) {
            // No guessed api-set, KnownDLL or arbitrary search directory proof.
            // A registered factory must provide the actual resolved OS closure.
            return Err(io::ErrorKind::Unsupported.into());
        }
        let mut digest = Sha256::new();
        digest.update(b"dac-windows-image-closure.v1\0");
        for image in std::iter::once(&supervisor).chain(std::iter::once(&payload)).chain(closure.iter()) {
            let encoded = format!("{:?}\0{}\0{}", image.description.identity, image.description.sha256, image.description.bytes);
            digest.update((encoded.len() as u64).to_be_bytes()); digest.update(encoded.as_bytes());
        }
        let _candidate = Self { supervisor, payload, closure, closure_hash: format!("{:x}", digest.finalize()) };
        // This public descriptor constructor has no original preloader token.
        // The separate in-process bootstrap may hold preloaded evidence, but it
        // cannot be reconstructed here from paths/hashes or a JSON descriptor.
        // Managed Work activation also needs the registered custody bridge.
        Err(io::ErrorKind::Unsupported.into())
    }
    pub(crate) fn open_original(authority: &impl OriginalAuthority, supervisor: Description, payload: Description) -> io::Result<Self> {
        authority.current()?;
        let supervisor = Image::open(supervisor)?;
        let payload = Image::open(payload)?;
        let resolved = supervisor.imports.iter().chain(payload.imports.iter())
            .map(|name| authority.resolve_system_import(name)).collect::<io::Result<Vec<_>>>()?;
        let closure = authority.system_images()?.into_iter().map(|image| Image::open_image(image, true, None, authority.system_machine())).collect::<io::Result<Vec<_>>>()?;
        if closure.is_empty() || closure.len() > 128 || supervisor.description.identity == payload.description.identity ||
            std::iter::once(&supervisor).chain(std::iter::once(&payload)).chain(closure.iter())
                .try_fold(0u64, |bytes, image| bytes.checked_add(image.description.bytes).ok_or(io::ErrorKind::InvalidData))? > 536_870_912 {
            return Err(io::ErrorKind::Unsupported.into());
        }
        for resolved in resolved {
            if !closure.iter().any(|image| image.description.identity == resolved) {
                return Err(io::ErrorKind::Unsupported.into());
            }
        }
        let mut digest = Sha256::new();
        digest.update(b"dac-windows-original-work-images.v1\0");
        for image in std::iter::once(&supervisor).chain(std::iter::once(&payload)).chain(closure.iter()) {
            digest.update(format!("{:?}\0{}\0{}\0", image.description.identity, image.description.sha256, image.description.bytes).as_bytes());
        }
        let result = Self { supervisor, payload, closure, closure_hash: format!("{:x}", digest.finalize()) };
        authority.current()?; result.current()?; Ok(result)
    }
    pub(crate) fn supervisor(&self) -> &Image { &self.supervisor }
    pub(crate) fn libraries(&self) -> &[Image] { &self.closure }
    pub fn closure_hash(&self) -> &str { &self.closure_hash }
    pub fn current(&self) -> io::Result<()> {
        for (index,image) in std::iter::once(&self.supervisor).chain(std::iter::once(&self.payload)).chain(self.closure.iter()).enumerate() {
            image.current_role(if index == 0 { "supervisor" } else if index == 1 { "payload" } else { "system-library" })?;
        }
        Ok(())
    }
    pub fn supervisor_suspended(&self, argv: &[String]) -> io::Result<Suspended<'_>> { self.current()?; self.supervisor.suspended(argv) }
    pub fn payload(&self) -> &Image { &self.payload }
}
impl Suspended<'_> {
    pub fn process(&self) -> HANDLE { self.process.hProcess }
    pub fn thread(&self) -> HANDLE { self.process.hThread }
    pub fn id(&self) -> u32 { self.process.dwProcessId }
    pub fn current(&self) -> io::Result<()> { self.image.verify_process(self.process.hProcess) }
}
impl Drop for Suspended<'_> {
    fn drop(&mut self) { unsafe {
        TerminateProcess(self.process.hProcess, 125); WaitForSingleObject(self.process.hProcess, 5000);
        CloseHandle(self.process.hThread); CloseHandle(self.process.hProcess);
    } }
}

fn image_links(file:&File)->io::Result<u32>{
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandleEx,FileStandardInfo,FILE_STANDARD_INFO};
    let mut value:FILE_STANDARD_INFO=unsafe{std::mem::zeroed()};
    if unsafe{GetFileInformationByHandleEx(file.as_raw_handle()as HANDLE,FileStandardInfo,(&raw mut value).cast(),std::mem::size_of::<FILE_STANDARD_INFO>()as u32)}==0{return Err(io::Error::last_os_error());}
    if value.Directory!=0||value.DeletePending!=0||value.NumberOfLinks==0{return Err(io::ErrorKind::PermissionDenied.into());}
    Ok(value.NumberOfLinks)
}
fn imports(bytes: &[u8]) -> io::Result<Vec<String>> {
    let u16_at = |offset: usize| bytes.get(offset..offset+2).map(|value| u16::from_le_bytes([value[0],value[1]])).ok_or(io::ErrorKind::InvalidData);
    let u32_at = |offset: usize| bytes.get(offset..offset+4).map(|value| u32::from_le_bytes([value[0],value[1],value[2],value[3]])).ok_or(io::ErrorKind::InvalidData);
    if bytes.get(..2) != Some(b"MZ") { return Err(io::ErrorKind::InvalidData.into()); }
    let pe = u32_at(0x3c)? as usize;
    if bytes.get(pe..pe+4) != Some(b"PE\0\0") || ![0x8664, 0xaa64].contains(&u16_at(pe+4)?) { return Err(io::ErrorKind::Unsupported.into()); }
    let count = u16_at(pe+6)? as usize;
    let optional = pe.checked_add(24).ok_or(io::ErrorKind::InvalidData)?;
    let optional_bytes = u16_at(pe+20)? as usize;
    if count == 0 || count > 96 || optional_bytes < 240 || u16_at(optional)? != 0x20b { return Err(io::ErrorKind::InvalidData.into()); }
    let sections = optional.checked_add(optional_bytes).ok_or(io::ErrorKind::InvalidData)?;
    let offset = |rva: u32| -> io::Result<usize> {
        for index in 0..count {
            let start = sections+index*40;
            let address = u32_at(start+12)?;
            let size = u32_at(start+16)?;
            if rva >= address && rva-address < size {
                return (u32_at(start+20)? as usize).checked_add((rva-address) as usize).filter(|value| *value < bytes.len()).ok_or(io::ErrorKind::InvalidData.into());
            }
        }
        Err(io::ErrorKind::InvalidData.into())
    };
    let mut names = std::collections::BTreeSet::new();
    for (table,length,stride,name_offset,delayed) in [
        (u32_at(optional+120)?,u32_at(optional+124)? as usize,20,12,false),
        (u32_at(optional+216)?,u32_at(optional+220)? as usize,32,4,true),
    ] {
        if table == 0 && length == 0 { continue; }
        if table == 0 || length < stride || length > 65_536 { return Err(io::ErrorKind::InvalidData.into()); }
        let base = offset(table)?;
        let mut ended = false;
        for index in 0..=128 {
            if index*stride+stride > length { return Err(io::ErrorKind::InvalidData.into()); }
            let item = base+index*stride;
            let name = u32_at(item+name_offset)?;
            if name == 0 { ended = true; break; }
            // RVA-based PE32+ delay imports are supported. VA-based legacy
            // descriptors cannot be reinterpreted as an observed system path.
            if index == 128 || (delayed && u32_at(item)? != 1) { return Err(io::ErrorKind::Unsupported.into()); }
            let start = offset(name)?;
            let end = bytes[start..].iter().take(256).position(|value| *value == 0).ok_or(io::ErrorKind::InvalidData)?;
            let name = std::str::from_utf8(&bytes[start..start+end]).map_err(|_| io::ErrorKind::InvalidData)?.to_ascii_lowercase();
            if !name.ends_with(".dll") || !name.bytes().all(|value| value.is_ascii_alphanumeric() || b"-_.".contains(&value)) {
                return Err(io::ErrorKind::InvalidData.into());
            }
            // Valid LLVM PE import descriptors may repeat KERNEL32/kernel32.
            names.insert(name);
        }
        if !ended { return Err(io::ErrorKind::InvalidData.into()); }
    }
    Ok(names.into_iter().collect())
}
fn quote(value: &str) -> String {
    let mut result = String::from("\""); let mut slashes = 0;
    for value in value.chars() {
        if value == '\\' { slashes += 1; continue; }
        result.push_str(&"\\".repeat(if value == '"' { slashes*2+1 } else { slashes }));
        result.push(value); slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes*2)); result.push('"'); result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_pe_section_and_suspended_first_image_are_same_held_file() {
        let path = std::env::current_exe().unwrap();
        let file = File::open(&path).unwrap();
        let description = Description { identity: no_follow::identity(&file).unwrap(), bytes: file.metadata().unwrap().len(),
            sha256: format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap())), path };
        let image = Image::open(description.clone()).unwrap();
        let process = image.suspended(&["--list".into()]).unwrap();
        assert_ne!(process.id(), unsafe { GetCurrentProcessId() });
        process.current().unwrap();
        image.verify_process(unsafe { GetCurrentProcess() }).unwrap();
        assert!(Factory::open(description.clone(), description, Vec::new()).is_err());
    }
}
