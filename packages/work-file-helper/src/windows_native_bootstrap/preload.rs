//! The first OS-loaded fixed native launcher is the initial TCB. A later child
//! factory needs an original pre-load receipt; a post-load descriptor cannot
//! upgrade itself. No public method accepts an executable path or argv.
use crate::{loader::FirstLoad, no_follow::{self, LockedPath}, protocol::Identity};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::c_void, fs::File, io::{self, Read, Write}, mem::size_of,
    os::windows::{ffi::{OsStrExt, OsStringExt}, io::{AsRawHandle, FromRawHandle, OwnedHandle}}, path::{Path, PathBuf}, ptr};
use windows_sys::Win32::{Foundation::{CloseHandle, DuplicateHandle, GetHandleInformation, SetHandleInformation, DUPLICATE_SAME_ACCESS, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, FILETIME},
    Security::SECURITY_ATTRIBUTES, Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE},
    System::{Pipes::{CreatePipe, PeekNamedPipe, GetNamedPipeServerProcessId},
        Threading::{CreateProcessW, GetCurrentProcess, GetCurrentProcessId, GetProcessId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, ResumeThread, TerminateProcess,
            WaitForSingleObject, GetExitCodeProcess, PROCESS_INFORMATION, STARTUPINFOEXW, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
            DeleteProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, CREATE_SUSPENDED, CREATE_NO_WINDOW,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_DUP_HANDLE},
        JobObjects::{CreateJobObjectW, AssignProcessToJobObject, SetInformationJobObject, TerminateJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            QueryInformationJobObject, JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION}}};

const DOMAIN: &str = "dac.windows-native-preloader.v1";
const LIMIT: usize = 65_536;
const ENV: &str = "DAC_NATIVE_PRELOAD_HANDLES";
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Asset { bytes: u64, name: String, sha256: String }
// Declaration order is canonical JSON key order; all strings in this signed
// fixed-purpose contract are ASCII and no optional property is silently added.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Payload { domain: String, images: Vec<Asset>, purpose: String, target: String }
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest { payload: Payload, signature: String }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt { version: u8, parent_pid: u32, child_pid: u32, parent_birth: String, child_birth: String, manifest: Manifest,
    parent_image: Identity, images: Vec<Identity>, runtime: Identity }

pub struct Evidence { pub hash: String, purpose: String, files: Vec<File>, stamps: Vec<String>, parent: Handle }
impl Evidence {
    pub fn artifact_name(&self)->io::Result<&'static str>{match self.purpose.as_str(){"desktop-sidecar"=>Ok("node.js"),"compiled-bun-cli"=>Ok("deepagent-code.exe"),_=>Err(io::ErrorKind::Unsupported.into())}}
    pub fn node_file(&self) -> io::Result<&File> {
        if !matches!(self.purpose.as_str(),"desktop-sidecar"|"compiled-bun-cli") { return Err(io::ErrorKind::Unsupported.into()); }
        self.files.get(2).ok_or_else(|| io::ErrorKind::PermissionDenied.into())
    }
    pub fn current(&self) -> io::Result<()> {
        if unsafe { WaitForSingleObject(self.parent.0, 0) } == WAIT_OBJECT_0 || self.files.len() != 4 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        for (file, stamp) in self.files.iter().zip(&self.stamps) {
            if &no_follow::stamp(file)? != stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
        }
        Ok(())
    }
}
pub struct Child { process: Handle, thread: Handle, job: Handle, images: Vec<LockedPath>, inherited: Vec<Handle>,
    receipt_write: File, pid: u32, resumed: bool, cli:bool, _stdio:Vec<Handle> }
impl Child {
    pub fn id(&self) -> u32 { self.pid }
    pub fn poll(&self) -> io::Result<bool> {
        if self.process.0 == 0 || self.images.len() != 3 || self.inherited.len() != 5 { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(unsafe { WaitForSingleObject(self.process.0, 0) } == WAIT_OBJECT_0)
    }
    pub fn cli_status(&self)->io::Result<Option<i32>> {
        if !self.cli{return Err(io::ErrorKind::PermissionDenied.into());}
        if !self.poll()?{return Ok(None);}
        let mut code=0;if unsafe{GetExitCodeProcess(self.process.0,&mut code)}==0{return Err(io::Error::last_os_error());}
        // The root exit never licenses surviving descendants. Retire this exact
        // unnamed parent Job before reporting its observed original exit code.
        self.stop()?;let mut observed:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=unsafe{std::mem::zeroed()};
        if unsafe{QueryInformationJobObject(self.job.0,JobObjectBasicAccountingInformation,(&raw mut observed).cast(),size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>()as u32,ptr::null_mut())}==0||observed.ActiveProcesses!=0{return Err(io::ErrorKind::PermissionDenied.into());}
        Ok(Some(code as i32))
    }
    pub fn resume(&mut self) -> io::Result<()> {
        if self.resumed { return Err(io::ErrorKind::PermissionDenied.into()); }
        for image in &self.images { image.current()?; super::loader::require_trusted(&image.file)?; }
        if unsafe { ResumeThread(self.thread.0) } != 1 { return Err(io::Error::last_os_error()); }
        self.resumed = true;
        Ok(())
    }
    pub fn stop(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.job.0, 125) } == 0 { return Err(io::Error::last_os_error()); }
        if unsafe { WaitForSingleObject(self.process.0, 5000) } != WAIT_OBJECT_0 { return Err(io::ErrorKind::TimedOut.into()); }
        if self.cli {
            let started=std::time::Instant::now();
            loop {
                let mut observed:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=unsafe{std::mem::zeroed()};
                if unsafe{QueryInformationJobObject(self.job.0,JobObjectBasicAccountingInformation,(&raw mut observed).cast(),size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>()as u32,ptr::null_mut())}==0{return Err(io::Error::last_os_error());}
                if observed.ActiveProcesses==0{break;}
                if started.elapsed()>=std::time::Duration::from_secs(5){return Err(io::ErrorKind::TimedOut.into());}
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        Ok(())
    }
}
impl Drop for Child { fn drop(&mut self) { let _ = self.stop(); } }
struct Handle(HANDLE);
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

fn bytes<const COUNT: usize>(text: &str) -> io::Result<[u8; COUNT]> {
    if text.len() != COUNT * 2 || !text.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut result = [0u8; COUNT];
    for (index, value) in result.iter_mut().enumerate() { *value = u8::from_str_radix(&text[index*2..index*2+2], 16).map_err(io::Error::other)?; }
    Ok(result)
}
fn verify(manifest: &Manifest) -> io::Result<()> {
    let key = option_env!("DAC_NATIVE_PRELOADER_PUBLISHER_HEX").ok_or(io::ErrorKind::Unsupported)?;
    let key = VerifyingKey::from_bytes(&bytes::<32>(key)?).map_err(io::Error::other)?;
    if manifest.payload.domain != DOMAIN || !matches!(manifest.payload.purpose.as_str(), "sealed-node-backend" | "desktop-sidecar" | "compiled-bun-cli") ||
        manifest.payload.target != if cfg!(target_arch = "aarch64") { "win32-arm64" } else { "win32-x64" } ||
        manifest.payload.images.len() != 3 ||
        roles(manifest)?.iter().any(|name|
            manifest.payload.images.iter().filter(|image| image.name == *name).count() != 1) ||
        manifest.payload.images.iter().any(|image| image.bytes == 0 || image.bytes > 268_435_456 || bytes::<32>(&image.sha256).is_err()) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    key.verify_strict(&serde_json::to_vec(&manifest.payload)?, &Signature::from_bytes(&bytes::<64>(&manifest.signature)?)).map_err(io::Error::other)
}
fn roles(manifest: &Manifest) -> io::Result<[&'static str; 3]> {
    match manifest.payload.purpose.as_str() {
        "sealed-node-backend" => Ok(["native-image-factory.node", "node-runtime.exe", "native-backend.mjs"]),
        "desktop-sidecar" => Ok(["native-image-factory.node", "node.js", "sidecar.js"]),
        "compiled-bun-cli" => Ok(["native-image-factory.node", "deepagent-code.exe", "deepagent-code.exe.native-components.json"]),
        _ => Err(io::ErrorKind::Unsupported.into()),
    }
}
fn hash(file: &File, expected: &Asset) -> io::Result<()> {
    let stamp = no_follow::stamp(file)?;
    if file.metadata()?.len() != expected.bytes { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut reader = file.try_clone()?;
    use std::io::{Seek, SeekFrom};
    reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    if io::copy(&mut reader.take(expected.bytes + 1), &mut hash)? != expected.bytes ||
        format!("{:x}", hash.finalize()) != expected.sha256 || no_follow::stamp(file)? != stamp {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

pub fn launch(original:&FirstLoad)->io::Result<Child>{launch_fixed(original,false)}
pub fn launch_cli(original:&FirstLoad)->io::Result<Child>{launch_fixed(original,true)}
fn launch_fixed(original: &FirstLoad, cli:bool) -> io::Result<Child> {
    original.current()?;
    let directory = original.bootstrap_path()?.parent().ok_or(io::ErrorKind::Unsupported)?;
    let manifest_file = LockedPath::open(&directory.join("native-preloader.installation.json"), false, false)?;
    let mut body = Vec::new();
    manifest_file.file.try_clone()?.take((LIMIT + 1) as u64).read_to_end(&mut body)?;
    if body.len() > LIMIT { return Err(io::ErrorKind::InvalidInput.into()); }
    let manifest: Manifest = serde_json::from_slice(&body)?;
    verify(&manifest)?;
    if manifest.payload.purpose != if cli{"compiled-bun-cli"}else{"sealed-node-backend"} { return Err(io::ErrorKind::Unsupported.into()); }
    let images = roles(&manifest)?.iter()
        .map(|name| {
            let image = LockedPath::open(&directory.join(name), false, !matches!(*name,"native-backend.mjs"|"deepagent-code.exe.native-components.json"))?;
            hash(&image.file, manifest.payload.images.iter().find(|asset| asset.name == *name).ok_or(io::ErrorKind::PermissionDenied)?)?;
            Ok(image)
        }).collect::<io::Result<Vec<_>>>()?;
    if no_follow::identity(&images[0].file)? != original.description().bootstrap.identity ||
        images[0].canonical() != original.description().bootstrap.path { return Err(io::ErrorKind::PermissionDenied.into()); }
    let parent_image = original.original_host_file()?;
    if cli&&(no_follow::identity(parent_image)?!=no_follow::identity(&images[1].file)?||original.description().host.path!=images[1].canonical()){return Err(io::ErrorKind::PermissionDenied.into());}
    let mut inherited = std::iter::once(parent_image).chain(images.iter().map(|image| &image.file)).map(inherit).collect::<io::Result<Vec<_>>>()?;
    // The child receives a bounded query-only handle to this exact process
    // object. A parent PID or a later OpenProcess cannot establish its lifetime.
    let mut parent_process = 0;
    if unsafe { DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &mut parent_process,
        PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 1, 0) } == 0 { return Err(io::Error::last_os_error()); }
    inherited.push(Handle(parent_process));
    let pipe = pipe()?;
    let mut handles = std::iter::once(pipe.0.0).chain(inherited.iter().map(|handle| handle.0)).collect::<Vec<_>>();
    let marker = handles.iter().map(|handle|format!("{:x}",*handle as usize)).collect::<Vec<_>>().join(":");
    let stdio=if cli{original_stdio()?}else{Vec::new()};
    handles.extend(stdio.iter().map(|handle|handle.0));
    let attributes = Attributes::new(&handles)?;
    let runtime_path = directory.join(if cli{"deepagent-code.exe"}else{"node-runtime.exe"}); let entry_path = directory.join("native-backend.mjs");
    let application = wide(&runtime_path);
    let mut command = if cli{original_command_line()?}else{wide(format!("{} {}", quote(&runtime_path)?, quote(&entry_path)?))};
    let mut env = std::env::vars_os().filter(|(key, _)| key != ENV).map(|(key, value)| {
        if key.encode_wide().any(|value| value == 0) || value.encode_wide().any(|value| value == 0) { return Err(io::ErrorKind::InvalidData.into()); }
        Ok(wide(format!("{}={}", key.to_str().ok_or(io::ErrorKind::InvalidData)?, value.to_str().ok_or(io::ErrorKind::InvalidData)?)))
    }).collect::<io::Result<Vec<_>>>()?;
    env.push(wide(format!("{ENV}={marker}"))); env.sort();
    let environment = env.into_iter().flatten().chain([0]).collect::<Vec<_>>();
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32; startup.lpAttributeList = attributes.pointer();
    if cli{startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=stdio[0].0;startup.StartupInfo.hStdOutput=stdio[1].0;startup.StartupInfo.hStdError=stdio[2].0;}
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let job = Handle(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) });
    if job.0 == 0 { return Err(io::Error::last_os_error()); }
    let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&raw const limit).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { CreateProcessW(application.as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(), 1,
        CREATE_SUSPENDED | if cli{0}else{CREATE_NO_WINDOW} | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.as_ptr().cast(), ptr::null(), &startup.StartupInfo, &mut process) } == 0 { return Err(io::Error::last_os_error()); }
    let mut child = Child { process: Handle(process.hProcess), thread: Handle(process.hThread), job, images, inherited,
        receipt_write: File::from(unsafe { OwnedHandle::from_raw_handle(pipe.1.0 as *mut c_void) }), pid: process.dwProcessId, resumed: false, cli, _stdio:stdio };
    std::mem::forget(pipe.1);
    if unsafe { AssignProcessToJobObject(child.job.0, child.process.0) } == 0 {
        unsafe { TerminateProcess(child.process.0, 125); WaitForSingleObject(child.process.0, 5000); }
        return Err(io::Error::last_os_error());
    }
    let receipt = Receipt { version: 1, parent_pid: unsafe { GetCurrentProcessId() }, child_pid: child.pid,
        parent_birth: birth(unsafe { GetCurrentProcess() })?, child_birth: birth(child.process.0)?, manifest,
        parent_image: no_follow::identity(parent_image)?, images: child.images.iter().map(|image| no_follow::identity(&image.file)).collect::<io::Result<Vec<_>>>()?,
        runtime: no_follow::identity(&child.images[1].file)? };
    let body = serde_json::to_vec(&receipt)?;
    if body.len() > LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
    child.receipt_write.write_all(&(body.len() as u32).to_be_bytes())?;
    child.receipt_write.write_all(&body)?; child.receipt_write.flush()?;
    verify_process(child.process.0, &no_follow::identity(&child.images[1].file)?)?;
    original.current()?;
    child.resume()?;
    Ok(child)
}

/// Captured before the original utilityProcess fork. The only external bind
/// input is the PID obtained from that original Main object; a held kernel
/// process object and its fixed runtime image establish the actual identity.
pub struct Prepared { manifest: Manifest, manifest_file: LockedPath, stamp: String, images: Vec<LockedPath>,
    parent_image: File, parent: Handle, created: std::time::Instant, bound: Option<Bound> }
struct Bound { process: Handle, job: Handle, pipe_read: Handle, pipe_write: File, remote: Vec<HANDLE>, marker: String }
impl Prepared {
    pub fn current(&self) -> io::Result<()> {
        self.manifest_file.current()?; super::loader::require_trusted(&self.manifest_file.file)?;
        if no_follow::stamp(&self.manifest_file.file)? != self.stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
        for image in &self.images { image.current()?; super::loader::require_trusted(&image.file)?; }
        Ok(())
    }
    pub fn bind(&mut self, pid: u32, observed_birth: &str) -> io::Result<String> {
        self.current()?;
        if self.bound.is_some() || self.created.elapsed() > std::time::Duration::from_secs(5) || pid == 0 || pid == unsafe { GetCurrentProcessId() } {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let process = Handle(unsafe { OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000 | 1 | 0x100, 0, pid) });
        if process.0 == 0 { return Err(io::Error::last_os_error()); }
        verify_process(process.0, &no_follow::identity(&self.parent_image)?)?;
        if observed_birth.len() != 16 || birth(process.0)? != observed_birth { return Err(io::ErrorKind::PermissionDenied.into()); }
        if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let job = job()?;
        if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 { return Err(io::Error::last_os_error()); }
        let (pipe_read, pipe_write) = pipe()?;
        let mut bound = Bound { process, job, pipe_read, pipe_write: into_file(pipe_write), remote: Vec::new(), marker: String::new() };
        for handle in std::iter::once(bound.pipe_read.0).chain(std::iter::once(self.parent_image.as_raw_handle() as HANDLE))
            .chain(self.images.iter().map(|image| image.file.as_raw_handle() as HANDLE)).chain(std::iter::once(self.parent.0)) {
            let mut duplicate = 0;
            if unsafe { DuplicateHandle(GetCurrentProcess(), handle, bound.process.0, &mut duplicate, 0, 1, DUPLICATE_SAME_ACCESS) } == 0 {
                return Err(io::Error::last_os_error());
            }
            bound.remote.push(duplicate);
        }
        let receipt = Receipt { version: 1, parent_pid: unsafe { GetCurrentProcessId() }, child_pid: pid,
            parent_birth: birth(unsafe { GetCurrentProcess() })?, child_birth: birth(bound.process.0)?, manifest: self.manifest.clone(),
            parent_image: no_follow::identity(&self.parent_image)?, images: self.images.iter().map(|image| no_follow::identity(&image.file)).collect::<io::Result<Vec<_>>>()?,
            runtime: no_follow::identity(&self.parent_image)? };
        let body = serde_json::to_vec(&receipt)?;
        if body.len() > LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
        bound.pipe_write.write_all(&(body.len() as u32).to_be_bytes())?;
        bound.pipe_write.write_all(&body)?; bound.pipe_write.flush()?;
        self.current()?;
        bound.marker = bound.remote.iter().map(|handle| format!("{:x}", *handle as usize)).collect::<Vec<_>>().join(":");
        let marker = bound.marker.clone(); self.bound = Some(bound);
        Ok(marker)
    }
    pub fn close(&mut self) -> io::Result<()> {
        let Some(bound) = self.bound.as_ref() else { return Ok(()); };
        // Electron's exit notification can precede kernel process signalling
        // and job accounting. Join only the originally held objects, keeping
        // this same lease on timeout rather than reopening a PID or retiring
        // from an advisory JavaScript event.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        match unsafe { WaitForSingleObject(bound.process.0, 2000) } {
            WAIT_OBJECT_0 => {},
            0xffff_ffff => return Err(io::Error::last_os_error()),
            _ => return Err(io::ErrorKind::WouldBlock.into()),
        }
        loop {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { QueryInformationJobObject(bound.job.0, JobObjectBasicAccountingInformation, (&raw mut accounting).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, ptr::null_mut()) } == 0 { return Err(io::Error::last_os_error()); }
            if accounting.ActiveProcesses == 0 { break; }
            if std::time::Instant::now() >= deadline { return Err(io::ErrorKind::WouldBlock.into()); }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        self.bound = None;
        Ok(())
    }
}
impl Drop for Bound {
    fn drop(&mut self) {
        // These are only handles created by this original transfer. Never
        // interpret or close a numeric value received back through child IPC.
        for handle in &self.remote {
            let mut owned = 0;
            if unsafe { DuplicateHandle(self.process.0, *handle, GetCurrentProcess(), &mut owned, 0, 0, 1 | DUPLICATE_SAME_ACCESS) } != 0 {
                unsafe { CloseHandle(owned); }
            }
        }
        if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            unsafe { TerminateJobObject(self.job.0, 125); WaitForSingleObject(self.process.0, 5000); }
        }
    }
}
pub fn prepare_sidecar(original: &FirstLoad) -> io::Result<Prepared> {
    original.current()?;
    let directory = original.bootstrap_path()?.parent().ok_or(io::ErrorKind::Unsupported)?;
    let manifest_file = LockedPath::open(&directory.join("native-preloader.installation.json"), false, false)?;
    let stamp = no_follow::stamp(&manifest_file.file)?;
    let mut body = Vec::new(); manifest_file.file.try_clone()?.take((LIMIT + 1) as u64).read_to_end(&mut body)?;
    if body.len() > LIMIT { return Err(io::ErrorKind::InvalidInput.into()); }
    let manifest: Manifest = serde_json::from_slice(&body)?; verify(&manifest)?;
    if manifest.payload.purpose != "desktop-sidecar" { return Err(io::ErrorKind::Unsupported.into()); }
    let images = roles(&manifest)?.iter().map(|name| {
        let path = if *name == "sidecar.js" { directory.parent().ok_or(io::ErrorKind::Unsupported)?.join(name) } else { directory.join(name) };
        let image = LockedPath::open(&path, false, *name == "native-image-factory.node")?;
        hash(&image.file, manifest.payload.images.iter().find(|asset| asset.name == *name).ok_or(io::ErrorKind::PermissionDenied)?)?;
        Ok(image)
    }).collect::<io::Result<Vec<_>>>()?;
    if no_follow::identity(&images[0].file)? != original.description().bootstrap.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    let parent_image = original.original_host_file()?.try_clone()?;
    let mut parent = 0;
    if unsafe { DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &mut parent, PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let prepared = Prepared { manifest, manifest_file, stamp, images, parent_image, parent: Handle(parent), created: std::time::Instant::now(), bound: None };
    prepared.current()?; original.current()?;
    Ok(prepared)
}
fn into_file(handle: Handle) -> File {
    let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle.0 as *mut c_void) });
    std::mem::forget(handle);
    file
}
fn job() -> io::Result<Handle> {
    let job = Handle(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) });
    if job.0 == 0 { return Err(io::Error::last_os_error()); }
    let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&raw const limit).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

pub fn receive(original: &FirstLoad) -> io::Result<Option<Evidence>> {
    let Some(marker) = std::env::var_os(ENV) else { return Ok(None); };
    let marker = marker.to_str().ok_or(io::ErrorKind::PermissionDenied)?;
    accept(original, marker).map(Some)
}
pub fn accept(original: &FirstLoad, marker: &str) -> io::Result<Evidence> {
    if marker.len() > 128 { return Err(io::ErrorKind::PermissionDenied.into()); }
    let handles = marker.split(':').map(|value| usize::from_str_radix(value, 16).map_err(io::Error::other)).collect::<io::Result<Vec<_>>>()?;
    if handles.len() != 6 || handles.contains(&0) || handles.iter().collect::<std::collections::HashSet<_>>().len() != 6 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    for handle in &handles {
        let mut flags = 0;
        if unsafe { GetHandleInformation(*handle as HANDLE, &mut flags) } == 0 || flags & HANDLE_FLAG_INHERIT == 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    // Duplicate untrusted numeric values before owning anything. Rejection
    // must never close a handle belonging to another native module in this host.
    let mut pipe = duplicate_file(handles[0] as HANDLE)?;
    if unsafe { GetFileType(handles[0] as HANDLE) } != FILE_TYPE_PIPE { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut available = 0;
    if unsafe { PeekNamedPipe(handles[0] as HANDLE, ptr::null_mut(), 0, ptr::null_mut(), &mut available, ptr::null_mut()) } == 0 || available < 4 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut prefix = [0u8; 4]; pipe.read_exact(&mut prefix)?;
    let size = u32::from_be_bytes(prefix) as usize;
    if size == 0 || size > LIMIT || available < size as u32 + 4 { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut body = vec![0u8; size]; pipe.read_exact(&mut body)?;
    let receipt: Receipt = serde_json::from_slice(&body)?;
    verify(&receipt.manifest)?;
    let mut parent_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(handles[0] as HANDLE, &mut parent_pid) } == 0 || parent_pid != receipt.parent_pid ||
        receipt.version != 1 || receipt.child_pid != unsafe { GetCurrentProcessId() } { return Err(io::ErrorKind::PermissionDenied.into()); }
    let files = handles[1..5].iter().map(|handle| duplicate_file(*handle as HANDLE)).collect::<io::Result<Vec<_>>>()?;
    if receipt.images.len() != 3 { return Err(io::ErrorKind::PermissionDenied.into()); }
    for (file, expected) in files.iter().zip(std::iter::once(&receipt.parent_image).chain(receipt.images.iter())) {
        if no_follow::identity(file)? != *expected { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    for (file, name) in files[1..].iter().zip(roles(&receipt.manifest)?) {
        hash(file, receipt.manifest.payload.images.iter().find(|asset| asset.name == name).ok_or(io::ErrorKind::PermissionDenied)?)?;
    }
    if receipt.manifest.payload.purpose=="compiled-bun-cli"&&(receipt.parent_image!=receipt.runtime||receipt.images[1]!=receipt.runtime){return Err(io::ErrorKind::PermissionDenied.into());}
    if receipt.images[0] != original.description().bootstrap.identity || receipt.runtime != original.description().host.identity {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let parent = duplicate(handles[5] as HANDLE, false)?;
    if unsafe { GetProcessId(parent.0) } != parent_pid || birth(parent.0)? != receipt.parent_birth ||
        birth(unsafe { GetCurrentProcess() })? != receipt.child_birth { return Err(io::ErrorKind::PermissionDenied.into()); }
    verify_process(parent.0, &receipt.parent_image)?;
    let stamps = files.iter().map(no_follow::stamp).collect::<io::Result<Vec<_>>>()?;
    let result = Evidence { hash: format!("{:x}", Sha256::digest(body)), purpose: receipt.manifest.payload.purpose.clone(), files, stamps, parent };
    result.current()?;
    Ok(result)
}

pub fn birth(process: HANDLE) -> io::Result<String> {
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit = creation; let mut kernel = creation; let mut user = creation;
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(format!("{:08x}{:08x}", creation.dwHighDateTime, creation.dwLowDateTime))
}
fn inherit(file: &File) -> io::Result<Handle> {
    let mut handle = 0;
    if unsafe { DuplicateHandle(GetCurrentProcess(), file.as_raw_handle() as HANDLE, GetCurrentProcess(), &mut handle, 0, 1, DUPLICATE_SAME_ACCESS) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Handle(handle))
}
fn duplicate(handle: HANDLE, inherited: bool) -> io::Result<Handle> {
    let mut result = 0;
    if unsafe { DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &mut result, 0, inherited as i32, DUPLICATE_SAME_ACCESS) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Handle(result))
}
fn duplicate_file(handle: HANDLE) -> io::Result<File> {
    let duplicate = duplicate(handle, false)?;
    let file = File::from(unsafe { OwnedHandle::from_raw_handle(duplicate.0 as *mut c_void) });
    std::mem::forget(duplicate);
    Ok(file)
}
fn verify_process(process: HANDLE, expected: &Identity) -> io::Result<()> {
    let mut path = vec![0u16; 2049]; let mut size = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 1, path.as_mut_ptr(), &mut size) } == 0 || size == 0 || size as usize >= path.len() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let path = super::loader::device_path(&String::from_utf16(&path[..size as usize]).map_err(io::Error::other)?)?;
    let observed = LockedPath::open(&path, false, true)?;
    if no_follow::identity(&observed.file)? != *expected { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(())
}
fn pipe() -> io::Result<(Handle, Handle)> {
    let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: ptr::null_mut(), bInheritHandle: 1 };
    let mut read = 0; let mut write = 0;
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, LIMIT as u32 + 4) } == 0 { return Err(io::Error::last_os_error()); }
    let pair = (Handle(read), Handle(write));
    if unsafe { SetHandleInformation(write, HANDLE_FLAG_INHERIT, 0) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(pair)
}
struct Attributes { bytes: Vec<usize> }
impl Attributes {
    fn pointer(&self) -> *mut c_void { self.bytes.as_ptr().cast_mut().cast() }
    fn new(handles: &[HANDLE]) -> io::Result<Self> {
        let mut size = 0;
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size); }
        if size == 0 || size > 65_536 { return Err(io::ErrorKind::InvalidData.into()); }
        let mut bytes = vec![0usize; size.div_ceil(size_of::<usize>())];
        if unsafe { InitializeProcThreadAttributeList(bytes.as_mut_ptr().cast(), 1, 0, &mut size) } == 0 { return Err(io::Error::last_os_error()); }
        let result = Self { bytes };
        if unsafe { UpdateProcThreadAttribute(result.pointer(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast_mut().cast(), std::mem::size_of_val(handles), ptr::null_mut(), ptr::null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(result)
    }
}
impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.pointer()); } } }
fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> { value.as_ref().encode_wide().chain([0]).collect() }
fn quote(path: &Path) -> io::Result<String> {
    let value = path.to_str().ok_or(io::ErrorKind::InvalidData)?;
    if value.contains(['"', '\0']) { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(format!("\"{value}\""))
}

#[link(name="kernel32")]
unsafe extern "system"{fn GetStdHandle(kind:u32)->HANDLE;fn GetCommandLineW()->*const u16;}
fn original_stdio()->io::Result<Vec<Handle>> {
    [-10i32,-11,-12].into_iter().map(|kind|{let handle=unsafe{GetStdHandle(kind as u32)};
        if handle==0||handle==-1||!matches!(unsafe{GetFileType(handle)},1|2|3){return Err(io::ErrorKind::PermissionDenied.into());}
        duplicate(handle,true)
    }).collect()
}
fn original_command_line()->io::Result<Vec<u16>> {
    let pointer=unsafe{GetCommandLineW()};if pointer.is_null(){return Err(io::ErrorKind::PermissionDenied.into());}
    let mut length=0;while length<32768&&unsafe{*pointer.add(length)}!=0{length+=1;}
    if length==0||length>=32768{return Err(io::ErrorKind::InvalidData.into());}
    Ok(unsafe{std::slice::from_raw_parts(pointer,length+1)}.to_vec())
}
