//! Fixed helper transport. Its original image/job/pipe handles stay owned until
//! root join, empty job, both EOFs and the bounded input writer have retired.
use super::work_factory::WorkFactory;
use std::{ffi::c_void, fs::File, io::{self, Read, Write}, mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle}}, ptr,
    sync::mpsc::{self, SyncSender}, thread::{self, JoinHandle}};
use windows_sys::Win32::{Foundation::{HANDLE, CloseHandle, SetHandleInformation, GetHandleInformation, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, ERROR_BROKEN_PIPE},
    Security::SECURITY_ATTRIBUTES, System::{Pipes::{CreatePipe, PeekNamedPipe},
    JobObjects::{CreateJobObjectW, AssignProcessToJobObject, IsProcessInJob, SetInformationJobObject,
        QueryInformationJobObject, TerminateJobObject, JobObjectExtendedLimitInformation, JobObjectBasicAccountingInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK},
    Threading::{CreateProcessW, ResumeThread, TerminateProcess, GetExitCodeProcess, WaitForSingleObject, PROCESS_INFORMATION,
        STARTUPINFOEXW, STARTF_USESTDHANDLES, CREATE_SUSPENDED, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, InitializeProcThreadAttributeList, UpdateProcThreadAttribute, DeleteProcThreadAttributeList,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        GetProcessMitigationPolicy, ProcessSignaturePolicy, ProcessImageLoadPolicy}}};
const INPUT_LIMIT: usize = 1_048_580;
const OUTPUT_PAGE: usize = 65_536;
struct Handle(HANDLE);
impl Drop for Handle { fn drop(&mut self) { if self.0 != 0 { unsafe { CloseHandle(self.0); } } } }
struct Output { file: File, eof: bool }
pub(super) struct PipeBytes(pub Vec<u8>);
impl Drop for PipeBytes {
    fn drop(&mut self) {
        for byte in &mut self.0 { unsafe { ptr::write_volatile(byte, 0); } }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}
pub struct Child { processes: u32, process: Handle, job: Handle, id: u32, input: Option<SyncSender<PipeBytes>>, writer: Option<JoinHandle<io::Result<()>>>,
    stdout: Output, stderr: Output, next_stdout: bool, exited: bool, stopped: bool, browser_custody: bool }
pub struct Observation { pub kind: &'static str, pub bytes: Vec<u8>, pub exit_code: Option<i32> }
impl Child {
    pub fn launch(factory: &WorkFactory) -> io::Result<Self> {
        Self::launch_fixed(factory, factory.helper(), 1, factory.windows_environment())
    }
    pub(super) fn launch_supervisor(factory: &WorkFactory) -> io::Result<Self> {
        Self::launch_fixed(factory, factory.factory().supervisor(), 2, factory.supervisor_environment())
    }
    fn launch_fixed(factory: &WorkFactory, image: &crate::native_windows::image_factory::Image, processes: u32, environment: &[u16]) -> io::Result<Self> {
        if processes != 1 && processes != 2 { return Err(io::ErrorKind::PermissionDenied.into()); }
        Self::launch_image(factory, image, processes, environment, None)
    }
    /// Trusted fixed Git has its own vendor-image closure. This port cannot be
    /// selected by helper/payload callers and does not claim LPAC isolation.
    pub(super) fn launch_git(factory: &WorkFactory, git: &super::event_git::Git,
        args: &[String], directory: &std::path::Path, environment: &[u16]) -> io::Result<Self> {
        git.current()?;
        Self::launch_image(factory, git.image(), 1, environment, Some((args, directory)))
    }
    fn launch_image(factory: &WorkFactory, image: &crate::native_windows::image_factory::Image,
        processes: u32, environment: &[u16], git: Option<(&[String], &std::path::Path)>) -> io::Result<Self> {
        image.current()?; factory.factory().current()?;
        let stdin = pipe(false)?; let stdout = pipe(true)?; let stderr = pipe(true)?;
        let handles = [stdin.0.as_raw_handle() as HANDLE, stdout.1.as_raw_handle() as HANDLE, stderr.1.as_raw_handle() as HANDLE];
        for handle in handles { require_inheritance(handle,true)?; }
        for handle in [stdin.1.as_raw_handle(),stdout.0.as_raw_handle(),stderr.0.as_raw_handle()] { require_inheritance(handle as HANDLE,false)?; }
        let attributes = phase("attributes", Attributes::new(&handles, git.is_none()))?;
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.pointer();
        let job = Handle(unsafe { CreateJobObjectW(ptr::null(),ptr::null()) });
        if job.0 == 0 { return Err(io::Error::last_os_error()); }
        require_inheritance(job.0,false)?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = processes; limits.ProcessMemoryLimit = 536_870_912;
        check(unsafe { SetInformationJobObject(job.0,JobObjectExtendedLimitInformation,(&raw const limits).cast(),size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) })?;
        job_limits(job.0, processes)?;
        let application = image.description().path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
        let mut command = format!("\"{}\"",image.description().path.to_str().ok_or(io::ErrorKind::InvalidData)?)
            .encode_utf16().chain([0]).collect::<Vec<_>>();
        if let Some((args, _)) = git {
            command.pop();
            let executable = image.description().path.to_str().ok_or(io::ErrorKind::InvalidData)?;
            command = std::iter::once(executable.to_owned()).chain(args.iter().cloned()).map(|arg| quote(&arg))
                .collect::<Vec<_>>().join(" ").encode_utf16().chain([0]).collect();
        }
        let directory = git.map(|(_, directory)| directory.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>());
        // The OS-root variables come only from the original held machine root.
        // No caller environment, PATH, credentials, shell or argv is inherited.
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        phase("create-process", check(unsafe { CreateProcessW(application.as_ptr(),command.as_mut_ptr(),ptr::null(),ptr::null(),1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),directory.as_ref().map_or(ptr::null(), |value|value.as_ptr()),&startup.StartupInfo,&mut process) }))?;
        let process_handle = Handle(process.hProcess); let thread_handle = Handle(process.hThread);
        let prepared = (|| -> io::Result<()> {
            image.verify_process(process_handle.0)?;
            check(unsafe { AssignProcessToJobObject(job.0,process_handle.0) })?;
            let mut member = 0; check(unsafe { IsProcessInJob(process_handle.0,job.0,&mut member) })?;
            if member == 0 || !job_count(job.0)?.eq(&1) { return Err(io::ErrorKind::PermissionDenied.into()); }
            let mut signatures=0u32;let mut loading=0u32;
            check(unsafe{GetProcessMitigationPolicy(process_handle.0,ProcessSignaturePolicy,(&raw mut signatures).cast(),size_of::<u32>())})?;
            check(unsafe{GetProcessMitigationPolicy(process_handle.0,ProcessImageLoadPolicy,(&raw mut loading).cast(),size_of::<u32>())})?;
            if (git.is_none() && signatures&1==0) || (git.is_some() && signatures&1!=0) || loading&4==0{return Err(io::ErrorKind::PermissionDenied.into());}
            image.current()?; factory.factory().current()?;
            if unsafe { ResumeThread(thread_handle.0) } != 1 { return Err(io::Error::last_os_error()); }
            Ok(())
        })();
        if let Err(error) = prepared {
            unsafe { TerminateJobObject(job.0,125); TerminateProcess(process_handle.0,125); }
            if unsafe { WaitForSingleObject(process_handle.0,5000) } != WAIT_OBJECT_0 || job_count(job.0).ok() != Some(0) {
                // Unknown custody is retained; a failed launch cannot authorize
                // another child or claim retirement of this original process.
                std::mem::forget((process_handle,thread_handle,job,stdin,stdout,stderr));
            }
            return Err(error);
        }
        drop(thread_handle); drop((stdin.0,stdout.1,stderr.1));
        let mut input = File::from(stdin.1); let (sender, receiver) = mpsc::sync_channel::<PipeBytes>(4);
        let writer = thread::spawn(move || { while let Ok(bytes) = receiver.recv() { input.write_all(&bytes.0)?; } input.flush() });
        Ok(Self { processes, process: process_handle, job, id: process.dwProcessId, input: Some(sender), writer: Some(writer),
            stdout: Output { file: File::from(stdout.0), eof: false }, stderr: Output { file: File::from(stderr.0), eof: false },
            next_stdout: true, exited: false, stopped: false, browser_custody: false })
    }
    pub fn id(&self) -> u32 { self.id }
    pub fn write(&self, bytes: Vec<u8>) -> io::Result<()> {
        let bytes = PipeBytes(bytes);
        if bytes.0.len() > INPUT_LIMIT || self.stopped || self.exited { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.input.as_ref().ok_or(io::ErrorKind::BrokenPipe)?.try_send(bytes).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => io::ErrorKind::WouldBlock.into(), mpsc::TrySendError::Disconnected(_) => io::ErrorKind::BrokenPipe.into() })
    }
    pub fn end(&mut self) -> io::Result<()> { if self.stopped || self.exited { return Err(io::ErrorKind::PermissionDenied.into()); } self.input.take(); Ok(()) }
    pub fn retain_browser_custody(&mut self) -> io::Result<()> {
        if self.browser_custody || self.stopped || self.exited { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.browser_custody = true; Ok(())
    }
    pub fn browser_custody(&self) -> bool { self.browser_custody && !self.exited }
    pub fn stop(&mut self) -> io::Result<()> {
        if self.browser_custody() { return Err(io::ErrorKind::WouldBlock.into()); }
        self.input.take(); self.stopped = true;
        check(unsafe { TerminateJobObject(self.job.0,125) })
    }
    pub fn read(&mut self) -> io::Result<Observation> {
        job_limits(self.job.0, self.processes)?;
        let stdout = self.next_stdout; self.next_stdout = !self.next_stdout;
        for selected in [stdout,!stdout] {
            let bytes = if selected { phase("read-stdout",self.stdout.read())? } else { phase("read-stderr",self.stderr.read())? };
            if !bytes.is_empty() { return Ok(Observation { kind: if selected { "stdout" } else { "stderr" }, bytes, exit_code: None }); }
        }
        if self.joined()? {
            self.exited = true; let mut code = 0; check(unsafe { GetExitCodeProcess(self.process.0,&mut code) })?;
            return Ok(Observation { kind: "exit", bytes: Vec::new(), exit_code: Some(code as i32) });
        }
        Ok(Observation { kind: "idle", bytes: Vec::new(), exit_code: None })
    }
    pub fn close(&mut self) -> io::Result<bool> {
        // Close is also an autonomous drain. An observer that retired or threw
        // cannot strand a full OS pipe and incorrectly free this Job lease.
        for _ in 0..32 { if PipeBytes(self.stdout.read()?).0.is_empty() && PipeBytes(self.stderr.read()?).0.is_empty() { break; } }
        self.joined()
    }
    fn joined(&mut self) -> io::Result<bool> {
        if unsafe { WaitForSingleObject(self.process.0,0) } != WAIT_OBJECT_0 || job_count(self.job.0)? != 0 || !self.stdout.eof || !self.stderr.eof { return Ok(false); }
        self.input.take();
        if self.writer.as_ref().is_some_and(|thread| !thread.is_finished()) { return Ok(false); }
        if let Some(thread) = self.writer.take() { let result = thread.join().map_err(|_| io::ErrorKind::BrokenPipe)?;
            if let Err(error) = result {
                if !self.stopped {
                    let mut code = 0;
                    let observed = unsafe { GetExitCodeProcess(self.process.0,&mut code) } != 0;
                    eprintln!("WINDOWS_WORK_HELPER_FAILURE stage=writer-join kind={:?} os={} exit_known={observed} exit_code={code}",error.kind(),error.raw_os_error().unwrap_or(0));
                    return Err(error);
                }
            }
        }
        self.exited = true; Ok(true)
    }
    pub fn retire(mut self) -> Result<(),Self> {
        let _ = self.stop();
        let started = std::time::Instant::now();
        while started.elapsed() < std::time::Duration::from_secs(5) {
            if self.close().ok() == Some(true) { return Ok(()); }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        Err(self)
    }
}
impl Drop for Child { fn drop(&mut self) { if self.exited { return; } let _ = self.stop(); } }
impl Output {
    fn read(&mut self) -> io::Result<Vec<u8>> {
        if self.eof { return Ok(Vec::new()); }
        let mut available = 0;
        if unsafe { PeekNamedPipe(self.file.as_raw_handle() as HANDLE,ptr::null_mut(),0,ptr::null_mut(),&mut available,ptr::null_mut()) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) { self.eof = true; return Ok(Vec::new()); } return Err(error);
        }
        if available == 0 { return Ok(Vec::new()); }
        let mut bytes = PipeBytes(vec![0u8;(available as usize).min(OUTPUT_PAGE)]); let count = self.file.read(&mut bytes.0)?;
        if count == 0 { self.eof = true; } bytes.0.truncate(count); Ok(std::mem::take(&mut bytes.0))
    }
}
fn require_inheritance(handle: HANDLE, expected: bool) -> io::Result<()> {
    let mut flags=0; check(unsafe { GetHandleInformation(handle,&mut flags) })?;
    if (flags & HANDLE_FLAG_INHERIT != 0) != expected { return Err(io::ErrorKind::PermissionDenied.into()); } Ok(())
}
fn job_limits(job: HANDLE, processes: u32) -> io::Result<()> {
    require_inheritance(job,false)?;
    let mut value: JOBOBJECT_EXTENDED_LIMIT_INFORMATION=unsafe { zeroed() }; let mut size=0;
    check(unsafe { QueryInformationJobObject(job,JobObjectExtendedLimitInformation,(&raw mut value).cast(),size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,&mut size) })?;
    let flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    if size as usize!=size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() || value.BasicLimitInformation.LimitFlags!=flags ||
        value.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0 ||
        value.BasicLimitInformation.ActiveProcessLimit!=processes || value.ProcessMemoryLimit!=536_870_912 {
        return Err(io::ErrorKind::PermissionDenied.into());
    } Ok(())
}
fn job_count(job: HANDLE) -> io::Result<u32> {
    let mut value: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() }; let mut size = 0;
    check(unsafe { QueryInformationJobObject(job,JobObjectBasicAccountingInformation,(&raw mut value).cast(),size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,&mut size) })?;
    if size as usize != size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() { return Err(io::ErrorKind::InvalidData.into()); } Ok(value.ActiveProcesses)
}
fn pipe(parent_reads: bool) -> io::Result<(OwnedHandle,OwnedHandle)> {
    let mut read = 0; let mut write = 0;
    let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,lpSecurityDescriptor: ptr::null_mut(),bInheritHandle: 1 };
    if unsafe { CreatePipe(&mut read,&mut write,&attributes,65_536) } == 0 { return Err(io::Error::last_os_error()); }
    let read = unsafe { OwnedHandle::from_raw_handle(read as *mut c_void) }; let write = unsafe { OwnedHandle::from_raw_handle(write as *mut c_void) };
    check(unsafe { SetHandleInformation(if parent_reads { read.as_raw_handle() } else { write.as_raw_handle() } as HANDLE,HANDLE_FLAG_INHERIT,0) })?;
    Ok((read,write))
}
struct Attributes { storage: Vec<usize>, handles: Vec<HANDLE>, mitigation: Box<u64>, initialized: bool }
impl Attributes {
    fn new(handles: &[HANDLE], microsoft_only: bool) -> io::Result<Self> {
        let mut size = 0; unsafe { InitializeProcThreadAttributeList(ptr::null_mut(),2,0,&mut size); }
        if size == 0 || size > 65_536 { return Err(io::ErrorKind::Unsupported.into()); }
        let mut result = Self { storage: vec![0usize;(size+size_of::<usize>()-1)/size_of::<usize>()],
            handles: handles.to_vec(), mitigation: Box::new((if microsoft_only { 1u64<<44 } else { 0 })|(1u64<<60)), initialized: false };
        phase("attributes-init", check(unsafe { InitializeProcThreadAttributeList(result.storage.as_mut_ptr().cast(),2,0,&mut size) }))?;
        result.initialized = true;
        phase("attributes-handles", check(unsafe { UpdateProcThreadAttribute(result.pointer(),0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,result.handles.as_ptr().cast(),size_of_val(result.handles.as_slice()),ptr::null_mut(),ptr::null()) }))?;
        // The fixed trusted helper is contained by an unnamed, non-inherited
        // one-process Job with both breakaway modes disabled. Adding the
        // child-process-policy attribute prevents Windows DLL initialization
        // on the supported target; the Job already forbids a second process.
        // Per-child loader policy only: the fixed unsigned helper image is
        // allowed, while DLL resolution prefers System32 and requires Microsoft
        // system DLL signatures. No global SAC/AppArmor/application policy moves.
        // Windows retains each attribute value pointer until process creation.
        // Heap allocations survive both this return and the Attributes move.
        phase("attributes-mitigation", check(unsafe{UpdateProcThreadAttribute(result.pointer(),0,PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,(&raw const *result.mitigation).cast(),size_of::<u64>(),ptr::null_mut(),ptr::null())}))?;

        Ok(result)
    }
    fn pointer(&self) -> *mut c_void { self.storage.as_ptr() as *mut c_void }
}
impl Drop for Attributes { fn drop(&mut self) { if self.initialized { unsafe { DeleteProcThreadAttributeList(self.pointer()); } } } }
fn phase<A>(stage: &'static str, result: io::Result<A>) -> io::Result<A> {
    result.inspect_err(|error| eprintln!("WINDOWS_WORK_HELPER_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0)))
}
fn check(value: i32) -> io::Result<()> { if value == 0 { return Err(io::Error::last_os_error()); } Ok(()) }

fn quote(value: &str) -> String {
    let mut result = String::from("\""); let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' { slashes += 1; continue; }
        result.extend(std::iter::repeat_n('\\', if character == '"' { slashes * 2 + 1 } else { slashes }));
        slashes = 0; result.push(character);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2)); result.push('"'); result
}
