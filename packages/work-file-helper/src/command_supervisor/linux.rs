use super::{cgroup::Cgroup, common, linux_namespace, protocol::{Control, Event, Isolation, Run, Watchdog}};
use std::{fs::File, io::{self, Read, Write}, os::fd::{AsRawFd, FromRawFd}, sync::{Arc, Mutex, mpsc}, thread, time::{Duration, Instant}};

pub fn run(run: Run) -> io::Result<()> {
    let prepared = common::prepare(&run)?;
    let closure = linux_namespace::prepare(&run, &prepared)?;
    let cgroup = Cgroup::create(&run)?;
    let stdout = pipe()?;
    let stderr = pipe()?;
    let ready = pipe()?;
    let release = pipe()?;
    let parent = unsafe { libc::getpid() };
    let pid = unsafe { libc::fork() };
    if pid < 0 { return Err(io::Error::last_os_error()); }
    if pid == 0 {
        let result = (|| {
            linux_namespace::check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) })?;
            if unsafe { libc::getppid() } != parent { return Err(io::ErrorKind::BrokenPipe.into()); }
            // First barrier is before namespace setup, not Command::pre_exec:
            // std::process::spawn would block on its exec-error pipe at SIGSTOP.
            linux_namespace::check(unsafe { libc::raise(libc::SIGSTOP) })?;
            let input = File::open("/dev/null")?;
            linux_namespace::check(unsafe { libc::dup2(input.as_raw_fd(), 0) })?;
            drop(input);
            linux_namespace::check(unsafe { libc::dup2(stdout.1.as_raw_fd(), 1) })?;
            linux_namespace::check(unsafe { libc::dup2(stderr.1.as_raw_fd(), 2) })?;
            unsafe { libc::close(ready.0.as_raw_fd()); libc::close(release.1.as_raw_fd()); }
            linux_namespace::init(&run, &prepared, &closure, ready.1.as_raw_fd(), release.0.as_raw_fd())
        })();
        if let Err(error) = result {
            eprintln!("supervisor_setup_refused:{error}");
            unsafe { libc::_exit(125) };
        }
        unsafe { libc::_exit(125) };
    }
    drop(stdout.1); drop(stderr.1); drop(ready.1); drop(release.0);
    let output = Arc::new(Mutex::new(io::stdout()));
    let stdout = common::stream(stdout.0, output.clone(), run.nonce.clone(), "stdout", run.stdout_bytes);
    let stderr = common::stream(stderr.0, output.clone(), run.nonce.clone(), "stderr", run.stderr_bytes);
    let mut status = 0;
    if unsafe { libc::waitpid(pid, &mut status, libc::WUNTRACED) } != pid || !libc::WIFSTOPPED(status) {
        let _ = cgroup.kill();
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    if let Err(error) = cgroup.attach(pid) {
        // Attachment failure never resumes a child outside containment.
        unsafe { libc::kill(pid, libc::SIGKILL); libc::waitpid(pid, &mut status, 0); }
        return Err(error);
    }
    let started = Instant::now();
    linux_namespace::check(unsafe { libc::kill(pid, libc::SIGCONT) })?;
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
    let Isolation::Linux { cpu, .. } = &run.isolation else { return Err(io::ErrorKind::Unsupported.into()); };
    let interval = Duration::from_millis(cpu.poll_ms);
    let mut ready = ready.0;
    let mut release = release.1;
    let mut announced = false;
    let mut continued = false;
    let mut cancelled = false;
    let mut root_exit = false;
    let mut stopped_at = None;
    let mut triggers = Vec::new();
    let completion = (|| {
        loop {
            if !announced && poll(&ready, 0)? {
                let mut byte = [0];
                if ready.read(&mut byte)? != 1 || byte[0] != b'R' { return Err(io::ErrorKind::PermissionDenied.into()); }
                common::ready(&output, &run, pid as u32, "linux-cgroup2-single-payload-v1")?;
                announced = true;
            }
            match receiver.try_recv() {
                Ok(Ok(Control::Continue { .. })) if announced && !continued => {
                    // Parent rechecks the still-owned workspace before releasing
                    // the exact setup-complete init. No alternate process is used.
                    prepared.root.current()?;
                    release.write_all(b"C")?;
                    continued = true;
                }
                Ok(Ok(Control::Cancel { .. })) | Ok(Err(_)) => cancelled = true,
                Ok(_) => return Err(io::ErrorKind::PermissionDenied.into()),
                Err(mpsc::TryRecvError::Disconnected) => cancelled = true,
                Err(mpsc::TryRecvError::Empty) => {},
            }
            if !root_exit {
                let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
                if waited == pid { root_exit = true; }
                if waited < 0 { return Err(io::Error::last_os_error()); }
            }
            let elapsed = common::elapsed(started);
            let used = cgroup.cpu_micros()?;
            if elapsed >= run.timeout_ms && !triggers.contains(&"wall_time") { triggers.push("wall_time"); }
            if used >= cpu.total_watchdog_micros && !triggers.contains(&"cpu_total") { triggers.push("cpu_total"); }
            if cancelled || !triggers.is_empty() || root_exit {
                // Even a naturally exited root does not prove descendants gone.
                cgroup.kill()?;
                stopped_at.get_or_insert(Instant::now());
            }
            if root_exit && cgroup.empty()? && stdout.is_finished() && stderr.is_finished() { break; }
            if stopped_at.is_some_and(|time| time.elapsed() >= Duration::from_secs(5)) { return Err(io::ErrorKind::TimedOut.into()); }
            thread::sleep(interval);
        }
        let stdout = stdout.join().map_err(|_| io::ErrorKind::BrokenPipe)??;
        let stderr = stderr.join().map_err(|_| io::ErrorKind::BrokenPipe)??;
        if !announced || !stdout.eof || !stderr.eof || !cgroup.empty()? { return Err(io::ErrorKind::PermissionDenied.into()); }
        let cpu_micros = cgroup.cpu_micros()?;
        cgroup.remove()?;
        closure.remove()?;
        common::emit(&output, &Event::Stopped { version: 2, nonce: &run.nonce, root_exit: true, tree_empty: true,
            stdout, stderr, cancelled, exit_code: libc::WIFEXITED(status).then(|| libc::WEXITSTATUS(status)),
            signal: libc::WIFSIGNALED(status).then(|| libc::WTERMSIG(status)), elapsed_ms: common::elapsed(started),
            watchdog: Watchdog { poll_ms: cpu.poll_ms, cpu_micros, observed_threads_max: None,
                observed_output_bytes_max: None, triggered: triggers } })?;
        Ok(())
    })();
    if completion.is_err() {
        let _ = cgroup.kill();
        // Refusal is not a fabricated stop proof. If root/EOF/tree evidence was
        // not obtained, Host keeps custody and the charged unknown disposition.
        let _ = common::emit(&output, &Event::Unavailable { version: 2, nonce: &run.nonce, code: "SUPERVISOR_UNCONFIRMED" });
    }
    // The root is mounted only in the private namespace. The original stage is
    // empty and can be removed after the contained process tree has disappeared.
    if cgroup.empty().unwrap_or(false) { let _ = closure.remove(); }
    completion
}

fn pipe() -> io::Result<(File, File)> {
    let mut descriptors = [0; 2];
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 { return Err(io::Error::last_os_error()); }
    Ok((unsafe { File::from_raw_fd(descriptors[0]) }, unsafe { File::from_raw_fd(descriptors[1]) }))
}

fn poll(file: &File, timeout: i32) -> io::Result<bool> {
    let mut fd = libc::pollfd { fd: file.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    if unsafe { libc::poll(&mut fd, 1, timeout) } < 0 { return Err(io::Error::last_os_error()); }
    Ok(fd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0)
}
