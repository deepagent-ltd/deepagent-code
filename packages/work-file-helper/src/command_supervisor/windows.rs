use super::{common, protocol::{Control, Event, Isolation, Run, Watchdog}, windows_job::{Job, check}, windows_security::{Security, Handle, wide}};
use std::{fs::File, io, mem::{size_of, zeroed}, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr, sync::{Arc, Mutex, mpsc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, SetHandleInformation, HANDLE_FLAG_INHERIT}, Security::SECURITY_ATTRIBUTES,
    System::{Pipes::CreatePipe, Threading::{CreateProcessAsUserW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject, TerminateProcess,
        PROCESS_INFORMATION, STARTUPINFOEXW, CREATE_SUSPENDED, DETACHED_PROCESS, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY},
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD}}};

pub fn run(run: Run) -> io::Result<()> {
    let prepared = phase("prepare",common::prepare(&run))?;
    let job = phase("job",Job::create(&run))?;
    let stopped = Arc::new(AtomicBool::new(true));
    let mut security = phase("security",Security::create(&run, &prepared, stopped.clone()))?;
    let stdout = pipe(true)?;
    let stderr = pipe(true)?;
    let stdin = pipe(false)?;
    // Parent-side pipe handles are not inherited; only the explicit three
    // handles in PROC_THREAD_ATTRIBUTE_HANDLE_LIST reach the payload.
    let attributes = Attributes::new()?;
    let handles = [stdin.0.as_raw_handle() as HANDLE, stdout.1.as_raw_handle() as HANDLE, stderr.1.as_raw_handle() as HANDLE];
    let child_policy = 1u32;
    let package_policy = 1u32; // opt out of ALL_APPLICATION_PACKAGES broad access
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security.capabilities)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &package_policy)?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.pointer();
    // These OS/profile facts were captured by the original factory before this
    // fixed supervisor was launched. A recipe cannot supply or override them.
    let mut fixed = ["APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"].into_iter()
        .map(|name| std::env::var(name).map(|value| (name.to_owned(), value)).map_err(|_| io::ErrorKind::Unsupported.into()))
        .collect::<io::Result<std::collections::BTreeMap<_,_>>>()?;
    for (name,value) in &run.env { fixed.insert(name.clone(),value.clone()); }
    let mut environment = fixed.iter().flat_map(|(key, value)| wide(format!("{key}={value}"))).collect::<Vec<_>>();
    if environment.is_empty() { environment.push(0); }
    environment.push(0);
    let executable = wide(&run.executable.path);
    let mut command = wide(std::iter::once(&run.executable.path).chain(run.argv.iter()).map(|arg| quote(arg)).collect::<Vec<_>>().join(" "));
    let cwd = wide(prepared.root.path.join(run.cwd.as_deref().unwrap_or("")));
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    // A managed non-TTY payload uses only the three captured pipes. Attaching a
    // hidden console makes KernelBase initialize ConDrv under the restricted
    // token before payload code starts; detached creation avoids that unrelated
    // console namespace without changing token, Job or child-process limits.
    phase("create-suspended",check(unsafe { CreateProcessAsUserW(security.token.0, executable.as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(),
        1, CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.as_ptr().cast(), cwd.as_ptr(), &startup.StartupInfo, &mut process) }))?;
    stopped.store(false, Ordering::Release);
    // This owner is dropped before Security. Every error after CreateProcess
    // therefore stops the exact original process before ACL retirement can run.
    let child = Child { process: Handle(process.hProcess), thread: Handle(process.hThread), job: &job, stopped: stopped.clone() };
    let (stdout, stdout_write) = stdout;
    let (stderr, stderr_write) = stderr;
    drop((stdin, stdout_write, stderr_write));
    phase("job-attach",job.attach(child.process.0))?;
    phase("token-proof",security.verify_process(child.process.0))?;
    let output = Arc::new(Mutex::new(io::stdout()));
    let stdout = common::stream(File::from(stdout), output.clone(), run.nonce.clone(), "stdout", run.stdout_bytes);
    let stderr = common::stream(File::from(stderr), output.clone(), run.nonce.clone(), "stderr", run.stderr_bytes);
    common::ready(&output, &run, process.dwProcessId, "win32-job-appcontainer-single-payload-v1")?;
    let (sender, receiver) = mpsc::sync_channel(2);
    let nonce = run.nonce.clone();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let control = super::protocol::read::<Control>(&mut input);
            let valid = control.as_ref().is_ok_and(|value| value.matches(&nonce));
            if sender.send(control).is_err() || !valid { break; }
        }
    });
    let Isolation::Windows { cpu, .. } = &run.isolation else { return Err(io::ErrorKind::Unsupported.into()); };
    let started = Instant::now();
    let mut continued = false;
    let mut cancelled = false;
    let mut stopping = None;
    let mut thread_max = 0;
    let mut output_max = 0;
    let mut triggers = Vec::new();
    loop {
        match receiver.try_recv() {
            Ok(Ok(Control::Continue { .. })) if !continued => { prepared.root.current()?; phase("continue",job.resume(child.thread.0))?; continued = true; }
            Ok(Ok(Control::Cancel { .. })) | Ok(Err(_)) | Err(mpsc::TryRecvError::Disconnected) => cancelled = true,
            Ok(_) => return Err(io::ErrorKind::PermissionDenied.into()),
            Err(mpsc::TryRecvError::Empty) => {},
        }
        let root_exit = unsafe { WaitForSingleObject(child.process.0, 0) } == WAIT_OBJECT_0;
        if !root_exit { thread_max = thread_max.max(threads(process.dwProcessId)?); }
        output_max = output_max.max(security.output_bytes()?);
        for (trigger, reached) in [("wall_time", common::elapsed(started) >= run.timeout_ms),
            ("cpu_total", job.cpu_micros()? >= cpu.total_watchdog_micros), ("threads", thread_max > 64), ("output_bytes", output_max > 1_048_576)] {
            if reached && !triggers.contains(&trigger) { triggers.push(trigger); }
        }
        if cancelled || !triggers.is_empty() || root_exit {
            job.stop()?;
            stopping.get_or_insert(Instant::now());
        }
        if root_exit && job.empty()? && stdout.is_finished() && stderr.is_finished() { break; }
        if stopping.is_some_and(|value| value.elapsed() >= Duration::from_secs(5)) { return Err(io::ErrorKind::TimedOut.into()); }
        thread::sleep(Duration::from_millis(cpu.poll_ms));
    }
    let stdout = stdout.join().map_err(|_| io::ErrorKind::BrokenPipe)??;
    let stderr = stderr.join().map_err(|_| io::ErrorKind::BrokenPipe)??;
    let mut code = 0;
    check(unsafe { GetExitCodeProcess(child.process.0, &mut code) })?;
    if !stdout.eof || !stderr.eof || !job.empty()? { return Err(io::ErrorKind::PermissionDenied.into()); }
    stopped.store(true, Ordering::Release);
    // A stopped tree alone does not prove ACL/profile retirement. A failed or
    // changed retirement emits unavailable/unknown, never a successful Stop.
    phase("security-retire",security.retire())?;
    common::emit(&output, &Event::Stopped { version: 2, nonce: &run.nonce, root_exit: true, tree_empty: true,
        stdout, stderr, cancelled, exit_code: Some(code as i32), signal: None, elapsed_ms: common::elapsed(started),
        watchdog: Watchdog { poll_ms: cpu.poll_ms, cpu_micros: job.cpu_micros()?, observed_threads_max: Some(thread_max),
            observed_output_bytes_max: Some(output_max), triggered: triggers } })
}

struct Attributes { storage: Vec<usize> }
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut length = 0;
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 4, 0, &mut length); }
        if length == 0 || length > 65_536 { return Err(io::ErrorKind::Unsupported.into()); }
        let mut storage = vec![0usize; (length + size_of::<usize>() - 1) / size_of::<usize>()];
        // DeleteProcThreadAttributeList must never see an uninitialized list
        // when the second initialization call fails.
        check(unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 4, 0, &mut length) })?;
        Ok(Self { storage })
    }
    fn pointer(&self) -> *mut std::ffi::c_void { self.storage.as_ptr() as *mut _ }
    fn set<T>(&self, attribute: u32, value: &T) -> io::Result<()> {
        check(unsafe { UpdateProcThreadAttribute(self.pointer(), 0, attribute as usize, (value as *const T).cast(), size_of::<T>(), ptr::null_mut(), ptr::null()) })
    }
}
impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.pointer()); } } }

struct Child<'a> { process: Handle, thread: Handle, job: &'a Job, stopped: Arc<AtomicBool> }
impl Drop for Child<'_> {
    fn drop(&mut self) {
        if self.stopped.load(Ordering::Acquire) { return; }
        let _ = self.job.stop();
        // Assignment itself can fail, so the original root also has an exact
        // termination path independent of Job membership.
        unsafe { TerminateProcess(self.process.0, 125); }
        if unsafe { WaitForSingleObject(self.process.0, 5000) } == WAIT_OBJECT_0 && self.job.empty().unwrap_or(false) {
            self.stopped.store(true, Ordering::Release);
        }
    }
}

fn pipe(parent_reads: bool) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read = 0;
    let mut write = 0;
    let security = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: ptr::null_mut(), bInheritHandle: 1 };
    if unsafe { CreatePipe(&mut read, &mut write, &security, 0) } == 0 {
        let error = io::Error::last_os_error();
        unsafe { if read != 0 && read != -1 { CloseHandle(read); } if write != 0 && write != -1 { CloseHandle(write); } }
        return Err(error);
    }
    let read = unsafe { OwnedHandle::from_raw_handle(read as *mut _) };
    let write = unsafe { OwnedHandle::from_raw_handle(write as *mut _) };
    check(unsafe { SetHandleInformation(if parent_reads { read.as_raw_handle() } else { write.as_raw_handle() } as HANDLE,
        HANDLE_FLAG_INHERIT, 0) })?;
    Ok((read, write))
}
fn threads(pid: u32) -> io::Result<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == -1 { return Err(io::Error::last_os_error()); }
    let snapshot = Handle(snapshot);
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    if unsafe { Thread32First(snapshot.0, &mut entry) } == 0 { return Err(io::Error::last_os_error()); }
    let mut count = 0;
    loop {
        if entry.th32OwnerProcessID == pid { count += 1; }
        if unsafe { Thread32Next(snapshot.0, &mut entry) } == 0 { break; }
    }
    Ok(count)
}
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' { slashes += 1; continue; }
        if character == '"' { result.push_str(&"\\".repeat(slashes * 2 + 1)); result.push('"'); slashes = 0; continue; }
        result.push_str(&"\\".repeat(slashes)); result.push(character); slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2)); result.push('"'); result
}

#[cfg(test)]
mod tests {
    use super::{pipe, quote, Attributes};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    #[test]
    fn argv_preserves_quotes_backslashes_and_empty_values() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("C:\\path\\"), "\"C:\\path\\\\\"");
    }
    #[test]
    fn actual_pipes_inherit_only_the_payload_end() {
        for parent_reads in [true, false] {
            let (read, write) = pipe(parent_reads).unwrap();
            let mut read_flags = 0;
            let mut write_flags = 0;
            assert_ne!(unsafe { GetHandleInformation(read.as_raw_handle() as HANDLE, &mut read_flags) }, 0);
            assert_ne!(unsafe { GetHandleInformation(write.as_raw_handle() as HANDLE, &mut write_flags) }, 0);
            assert_eq!(read_flags & HANDLE_FLAG_INHERIT != 0, !parent_reads);
            assert_eq!(write_flags & HANDLE_FLAG_INHERIT != 0, parent_reads);
        }
    }
    #[test]
    fn actual_attribute_lists_initialize_and_release() {
        for _ in 0..32 { drop(Attributes::new().unwrap()); }
    }
}

fn phase<A>(stage:&'static str,value:io::Result<A>)->io::Result<A>{value.inspect_err(|error|eprintln!("WINDOWS_COMMAND_SUPERVISOR_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0)))}
