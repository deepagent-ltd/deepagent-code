//! The trusted init is the only process allowed to create the payload. Setup FDs
//! and capabilities are removed before exec; a read-only bind alone is insufficient.
use super::{common, protocol::{Isolation, Run}};
use crate::no_follow;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, ffi::CString, fs::{File, OpenOptions}, io::{self, Read, Write},
    os::{fd::{AsRawFd, RawFd}, unix::{fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}, ffi::OsStrExt}}, path::{Path, PathBuf}};

pub struct Closure { pub runtime: Vec<File>, pub outputs: Vec<File>, pub stage: PathBuf, stage_file: File }

/// AppArmor attaches to this exact installed supervisor image. Probing a
/// generic unshare, Node or Bun executable cannot qualify this boundary.
pub fn probe() -> io::Result<()> {
    let parent = unsafe { libc::getpid() };
    let pid = unsafe { libc::fork() };
    if pid < 0 { return Err(io::Error::last_os_error()); }
    if pid == 0 {
        let result = (|| {
            check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) })?;
            if unsafe { libc::getppid() } != parent { return Err(io::ErrorKind::BrokenPipe.into()); }
            let uid = unsafe { libc::getuid() };
            let gid = unsafe { libc::getgid() };
            check(unsafe { libc::unshare(libc::CLONE_NEWUSER) })?;
            std::fs::write("/proc/self/setgroups", "deny")?;
            std::fs::write("/proc/self/uid_map", format!("0 {uid} 1"))?;
            std::fs::write("/proc/self/gid_map", format!("0 {gid} 1"))?;
            check(unsafe { libc::unshare(libc::CLONE_NEWNS | libc::CLONE_NEWNET | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS | libc::CLONE_NEWPID) })?;
            check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) })?;
            if unsafe { libc::getppid() } != parent { return Err(io::ErrorKind::BrokenPipe.into()); }
            mount(None, Path::new("/"), None, libc::MS_REC | libc::MS_PRIVATE, None)?;
            check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) })?;
            super::linux_seccomp::drop_capabilities()?;
            super::linux_seccomp::install()
        })();
        unsafe { libc::_exit(if result.is_ok() { 0 } else { 1 }); }
    }
    let started = std::time::Instant::now();
    let mut status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if waited == pid {
            return if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 { Ok(()) }
                else { Err(io::ErrorKind::PermissionDenied.into()) };
        }
        if waited < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted { return Err(io::Error::last_os_error()); }
        if started.elapsed() >= std::time::Duration::from_secs(3) {
            unsafe { libc::kill(pid, libc::SIGKILL); }
            // The original PID is still this parent's unreaped child. Reap it
            // with bounded observation; timeout never becomes namespace proof.
            for _ in 0..100 {
                if unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } == pid { return Err(io::ErrorKind::TimedOut.into()); }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            return Err(io::ErrorKind::TimedOut.into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
impl Closure {
    pub fn remove(&self) -> io::Result<()> {
        let actual = self.stage_file.metadata()?;
        let named = self.stage.symlink_metadata()?;
        if !named.is_dir() || actual.dev() != named.dev() || actual.ino() != named.ino() ||
            named.uid() != unsafe { libc::geteuid() } || named.mode() & 0o077 != 0 ||
            std::fs::read_dir(&self.stage)?.next().is_some() { return Err(io::ErrorKind::PermissionDenied.into()); }
        std::fs::remove_dir(&self.stage)
    }
}

pub fn prepare(run: &Run, prepared: &common::Prepared) -> io::Result<Closure> {
    let Isolation::Linux { runtime_files, .. } = &run.isolation else { return Err(io::ErrorKind::Unsupported.into()); };
    let runtime = runtime_files.iter().map(common::image).collect::<io::Result<Vec<_>>>()?;
    let root = prepared.root.file.metadata()?;
    if root.uid() != unsafe { libc::geteuid() } || root.mode() & 0o077 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    let expected = run.inputs.iter().map(|input| input.relative.clone()).chain(run.outputs.iter().cloned()).collect::<BTreeSet<_>>();
    let mut actual = BTreeSet::new();
    scan(&prepared.root.path, "", &mut actual, &expected)?;
    if actual != expected { return Err(io::ErrorKind::PermissionDenied.into()); }
    for input in &run.inputs {
        let mut file = no_follow::open_relative(&prepared.root.file, &no_follow::relative(&input.relative)?)?;
        let stamp = no_follow::stamp(&file)?;
        if no_follow::identity(&file)? != input.identity || file.metadata()?.len() != input.bytes { return Err(io::ErrorKind::InvalidData.into()); }
        let mut hash = Sha256::new();
        if io::copy(&mut Read::by_ref(&mut file).take(input.bytes + 1), &mut hash)? != input.bytes ||
            format!("{:x}", hash.finalize()) != input.sha256 || no_follow::stamp(&file)? != stamp {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    let outputs = run.outputs.iter().map(|relative| {
        let path = prepared.root.path.join(relative);
        let file = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() != 0 || metadata.uid() != root.uid() || metadata.mode() & 0o177 != 0 ||
            no_follow::identity(&file)? != no_follow::identity(&no_follow::open_relative(&prepared.root.file, &no_follow::relative(relative)?)?)? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(file)
    }).collect::<io::Result<Vec<_>>>()?;
    let parent = prepared.root.path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let directory = no_follow::open_root(parent)?;
    if directory.metadata()?.uid() != root.uid() || directory.metadata()?.mode() & 0o077 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    let stage = parent.join(format!(".dac-isolation-{}", run.nonce));
    std::fs::DirBuilder::new().mode(0o700).create(&stage)?;
    let stage_file = no_follow::open_root(&stage)?;
    prepared.root.current()?;
    Ok(Closure { runtime, outputs, stage, stage_file })
}

fn scan(root: &Path, relative: &str, actual: &mut BTreeSet<String>, expected: &BTreeSet<String>) -> io::Result<()> {
    for entry in std::fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| io::ErrorKind::InvalidData)?;
        let path = if relative.is_empty() { name } else { format!("{relative}/{name}") };
        let parts = no_follow::relative(&path)?;
        if parts.len() > 16 { return Err(io::ErrorKind::InvalidInput.into()); }
        let stat = entry.path().symlink_metadata()?;
        if stat.uid() != unsafe { libc::geteuid() } { return Err(io::ErrorKind::PermissionDenied.into()); }
        // Original snapshot v1 owns two empty private directories. They remain
        // read-only in the payload and are retired by the original cleanup.
        if relative.is_empty() && [".dac-home", ".dac-tmp"].contains(&path.as_str()) && stat.is_dir() &&
            stat.mode() & 0o077 == 0 && std::fs::read_dir(entry.path())?.next().is_none() { continue; }
        if stat.is_dir() && stat.mode() & 0o077 == 0 && expected.iter().any(|value| value.starts_with(&format!("{path}/"))) {
            scan(root, &path, actual, expected)?;
            continue;
        }
        if !stat.is_file() || stat.nlink() != 1 || stat.mode() & 0o177 != 0 || !expected.contains(&path) || !actual.insert(path) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

/// Called in the still-single-threaded fork. The outer stub has already been
/// attached to its cgroup and cannot reach an untrusted executable here.
pub fn init(run: &Run, prepared: &common::Prepared, closure: &Closure, ready: RawFd, release: RawFd) -> io::Result<()> {
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    check(unsafe { libc::unshare(libc::CLONE_NEWUSER) })?;
    std::fs::write("/proc/self/setgroups", "deny")?;
    std::fs::write("/proc/self/uid_map", format!("0 {uid} 1"))?;
    std::fs::write("/proc/self/gid_map", format!("0 {gid} 1"))?;
    check(unsafe { libc::unshare(libc::CLONE_NEWNS | libc::CLONE_NEWNET | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS | libc::CLONE_NEWPID) })?;
    mount(None, Path::new("/"), None, libc::MS_REC | libc::MS_PRIVATE, None)?;
    let pid = unsafe { libc::fork() };
    if pid < 0 { return Err(io::Error::last_os_error()); }
    if pid > 0 {
        // This fixed trusted stub never executes payload code. Keep the outer
        // root process alive until its only child is reaped.
        unsafe { libc::close(ready); libc::close(release); libc::close(1); libc::close(2); }
        let mut status = 0;
        loop {
            let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
            if waited == pid { unsafe { libc::_exit(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) }) }; }
            if waited < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted { unsafe { libc::_exit(125) }; }
        }
    }
    let parent = unsafe { libc::getppid() };
    check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) })?;
    if unsafe { libc::getppid() } != parent { return Err(io::ErrorKind::BrokenPipe.into()); }
    mount(Some("tmpfs"), &closure.stage, Some("tmpfs"), libc::MS_NOSUID | libc::MS_NODEV, Some("size=1048576,mode=755"))?;
    let target = closure.stage.join("workspace");
    std::fs::create_dir(&target)?;
    let workspace = namespace_file(&prepared.root.file, &prepared.root.path)?;
    bind(workspace.as_raw_fd(), &target, true)?;
    // No owned File may remain after close_range. Otherwise an exec/setup
    // error would drop an already-closed FD and abort before its real errno.
    drop(workspace);
    for (relative, file) in run.outputs.iter().zip(&closure.outputs) {
        let output = namespace_file(file, &prepared.root.path.join(relative))?;
        bind(output.as_raw_fd(), &target.join(relative), false)?;
    }
    let Isolation::Linux { runtime_files, .. } = &run.isolation else { return Err(io::ErrorKind::Unsupported.into()); };
    for (image, file) in std::iter::once((&run.executable, &prepared.executable)).chain(runtime_files.iter().zip(&closure.runtime)) {
        let target = closure.stage.join(image.mount_path.as_deref().unwrap_or(&image.path).trim_start_matches('/'));
        if target.starts_with(closure.stage.join("workspace")) || target.starts_with(closure.stage.join("proc")) || target.starts_with(closure.stage.join("dev")) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        std::fs::create_dir_all(target.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        OpenOptions::new().write(true).create_new(true).open(&target)?;
        let current = namespace_file(file, Path::new(&image.path))?;
        bind(current.as_raw_fd(), &target, true)?;
    }
    std::fs::create_dir(closure.stage.join("dev"))?;
    for (name, major, minor) in [("null", 1, 3), ("urandom", 1, 9)] {
        let file = OpenOptions::new().read(true).write(name == "null").custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(format!("/dev/{name}"))?;
        let stat = file.metadata()?;
        if stat.mode() & libc::S_IFMT != libc::S_IFCHR || libc::major(stat.rdev()) != major || libc::minor(stat.rdev()) != minor {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let target = closure.stage.join("dev").join(name);
        OpenOptions::new().write(true).create_new(true).open(&target)?;
        bind(file.as_raw_fd(), &target, false)?;
    }
    std::fs::create_dir(closure.stage.join("proc"))?;
    mount(Some("proc"), &closure.stage.join("proc"), Some("proc"), libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, None)?;
    std::fs::create_dir(closure.stage.join("old-root"))?;
    check(unsafe { libc::chdir(cstring(&closure.stage)?.as_ptr()) })?;
    check(unsafe { libc::syscall(libc::SYS_pivot_root, c".".as_ptr(), c"old-root".as_ptr()) as i32 })?;
    check(unsafe { libc::chdir(c"/".as_ptr()) })?;
    check(unsafe { libc::umount2(c"/old-root".as_ptr(), libc::MNT_DETACH) })?;
    std::fs::remove_dir("/old-root")?;
    // Mount root itself read-only without changing per-output RW mount flags.
    mount(None, Path::new("/"), None, libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV, None)?;
    let cwd = format!("/workspace{}", run.cwd.as_ref().map_or(String::new(), |path| format!("/{path}")));
    check(unsafe { libc::chdir(CString::new(cwd).map_err(|_| io::ErrorKind::InvalidInput)?.as_ptr()) })?;
    let inherited = [prepared.executable.as_raw_fd(), ready, release].map(|fd| unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 64) });
    if inherited.iter().any(|fd| *fd < 0) { return Err(io::Error::last_os_error()); }
    let limit = libc::rlimit { rlim_cur: 64, rlim_max: 64 };
    check(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) })?;
    let size = libc::rlimit { rlim_cur: 1_048_576, rlim_max: 1_048_576 };
    check(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &size) })?;
    // close_range covers unknown inherited descriptors, including Host-control
    // and cgroup FDs. Only the initial executable and private barrier survive.
    for fd in 3..=5 { check(unsafe { libc::dup2(inherited[fd as usize - 3], fd) })?; }
    check(unsafe { libc::syscall(libc::SYS_close_range, 6u32, u32::MAX, 0u32) as i32 })?;
    check(unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) })?;
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) })?;
    super::linux_seccomp::drop_capabilities()?;
    super::linux_seccomp::install()?;
    if unsafe { libc::write(4, b"R".as_ptr().cast(), 1) } != 1 { return Err(io::ErrorKind::BrokenPipe.into()); }
    unsafe { libc::close(4); }
    let mut byte = 0u8;
    if unsafe { libc::read(5, (&mut byte as *mut u8).cast(), 1) } != 1 || byte != b'C' { return Err(io::ErrorKind::PermissionDenied.into()); }
    unsafe { libc::close(5); }
    let executable = CString::new(run.executable.path.as_str()).map_err(|_| io::ErrorKind::InvalidInput)?;
    let argv = std::iter::once(executable).chain(run.argv.iter().map(|arg| CString::new(arg.as_str()).expect("validated argument"))).collect::<Vec<_>>();
    let env = run.env.iter().map(|(name, value)| CString::new(format!("{name}={value}")).expect("validated environment")).collect::<Vec<_>>();
    let args = argv.iter().map(|arg| arg.as_ptr()).chain(std::iter::once(std::ptr::null())).collect::<Vec<_>>();
    let environment = env.iter().map(|value| value.as_ptr()).chain(std::iter::once(std::ptr::null())).collect::<Vec<_>>();
    // execveat uses the still-open verified image, not a path substituted after hashing.
    unsafe { libc::syscall(libc::SYS_execveat, 3, c"".as_ptr(), args.as_ptr(), environment.as_ptr(), libc::AT_EMPTY_PATH); }
    Err(io::Error::last_os_error())
}

fn namespace_file(original: &File, path: &Path) -> io::Result<File> {
    // An inherited O_PATH FD still references the old mount namespace; Linux
    // rejects its proc-fd bind with EINVAL after CLONE_NEWNS. Reopen with the
    // original no-follow traversal in the new namespace, then require the
    // exact original object/stamp before using the new FD as a mount source.
    let stamp = no_follow::stamp(original)?;
    let current = if original.metadata()?.is_dir() { no_follow::open_root(path)? } else {
        let parent = no_follow::open_root(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        let name = path.file_name().and_then(|name| name.to_str()).ok_or(io::ErrorKind::InvalidInput)?;
        no_follow::open_relative(&parent, &[name])?
    };
    if no_follow::stamp(&current)? != stamp || no_follow::stamp(original)? != stamp {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(current)
}

#[track_caller]
fn bind(fd: RawFd, target: &Path, readonly: bool) -> io::Result<()> {
    mount(Some(&format!("/proc/self/fd/{fd}")), target, None, libc::MS_BIND, None)?;
    if readonly {
        let attr = libc::mount_attr { attr_set: libc::MOUNT_ATTR_RDONLY | libc::MOUNT_ATTR_NOSUID,
            attr_clr: 0, propagation: 0, userns_fd: 0 };
        check(unsafe { libc::syscall(libc::SYS_mount_setattr, libc::AT_FDCWD, cstring(target)?.as_ptr(), libc::AT_RECURSIVE,
            &attr, std::mem::size_of::<libc::mount_attr>()) as i32 })?;
    }
    Ok(())
}

fn cstring(path: &Path) -> io::Result<CString> { CString::new(path.as_os_str().as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into()) }
#[track_caller]
fn mount(source: Option<&str>, target: &Path, filesystem: Option<&str>, flags: libc::c_ulong, data: Option<&str>) -> io::Result<()> {
    let source = source.map(CString::new).transpose().map_err(|_| io::ErrorKind::InvalidInput)?;
    let filesystem = filesystem.map(CString::new).transpose().map_err(|_| io::ErrorKind::InvalidInput)?;
    let data = data.map(CString::new).transpose().map_err(|_| io::ErrorKind::InvalidInput)?;
    check(unsafe { libc::mount(source.as_ref().map_or(std::ptr::null(), |value| value.as_ptr()), cstring(target)?.as_ptr(),
        filesystem.as_ref().map_or(std::ptr::null(), |value| value.as_ptr()), flags, data.as_ref().map_or(std::ptr::null(), |value| value.as_ptr().cast())) })
}
#[track_caller]
pub fn check(result: i32) -> io::Result<()> {
    if result < 0 {
        let error = io::Error::last_os_error();
        let caller = std::panic::Location::caller();
        // Fixed trusted source location and errno diagnose unavailable kernel
        // capabilities without disclosing request text, paths or credentials.
        return Err(io::Error::new(error.kind(), format!("namespace_setup:{} errno={}", caller.line(), error.raw_os_error().unwrap_or(0))));
    }
    Ok(())
}
