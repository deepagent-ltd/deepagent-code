//! cgroup v2 controls are installed before the first untrusted instruction.
//! cpu.max limits a rate. Aggregate usage is only a supervisor watchdog.
use super::protocol::{Isolation, Run};
use crate::no_follow;
use std::{ffi::CString, fs::File, io::{self, Read, Write}, os::{fd::{AsRawFd, FromRawFd}, unix::fs::MetadataExt}, path::Path};

pub struct Cgroup { parent: File, directory: File, name: CString }

impl Cgroup {
    pub fn create(run: &Run) -> io::Result<Self> {
        let Isolation::Linux { cpu, memory_max_bytes, memory_swap_max_bytes, tasks_max, delegated_cgroup, .. } = &run.isolation
            else { return Err(io::ErrorKind::Unsupported.into()); };
        let parent = no_follow::open_root(Path::new(delegated_cgroup))?;
        let stat = parent.metadata()?;
        if stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o022 != 0 ||
            std::fs::canonicalize(delegated_cgroup)? != Path::new(delegated_cgroup) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(parent.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { filesystem.assume_init() }.f_type as u64 != 0x6367_7270 {
            return Err(io::ErrorKind::Unsupported.into());
        }
        let controllers = read(&parent, "cgroup.controllers")?;
        let enabled = read(&parent, "cgroup.subtree_control")?;
        if !["cpu", "memory", "pids"].iter().all(|name|
            controllers.split_whitespace().any(|value| value == *name) && enabled.split_whitespace().any(|value| value == *name)) {
            return Err(io::ErrorKind::Unsupported.into());
        }
        let name = CString::new(format!("dac_{}", run.nonce)).map_err(|_| io::ErrorKind::InvalidInput)?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 { return Err(io::Error::last_os_error()); }
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        let value = Self { parent, directory: unsafe { File::from_raw_fd(fd) }, name };
        let configuration = (|| {
            write(&value.directory, "cpu.max", &format!("{} {}", cpu.quota_micros, cpu.period_micros))?;
            write(&value.directory, "memory.max", &memory_max_bytes.to_string())?;
            write(&value.directory, "memory.swap.max", &memory_swap_max_bytes.to_string())?;
            write(&value.directory, "pids.max", &tasks_max.to_string())?;
            if read(&value.directory, "cpu.max")?.trim() != format!("{} {}", cpu.quota_micros, cpu.period_micros) ||
                read(&value.directory, "memory.max")?.trim() != memory_max_bytes.to_string() ||
                read(&value.directory, "memory.swap.max")?.trim() != "0" ||
                read(&value.directory, "pids.max")?.trim() != tasks_max.to_string() || !value.empty()? {
                return Err(io::ErrorKind::InvalidData.into());
            }
            // Availability of cgroup.kill is a required capability, never SIGTERM fallback.
            open(&value.directory, "cgroup.kill", libc::O_WRONLY).map(drop)
        })();
        if let Err(error) = configuration { let _ = value.remove(); return Err(error); }
        Ok(value)
    }

    pub fn attach(&self, pid: libc::pid_t) -> io::Result<()> {
        if pid <= 0 { return Err(io::ErrorKind::InvalidInput.into()); }
        write(&self.directory, "cgroup.procs", &pid.to_string())?;
        let processes = read(&self.directory, "cgroup.procs")?;
        if !processes.lines().any(|line| line == pid.to_string()) { return Err(io::ErrorKind::InvalidData.into()); }
        Ok(())
    }

    pub fn kill(&self) -> io::Result<()> { write(&self.directory, "cgroup.kill", "1") }
    pub fn empty(&self) -> io::Result<bool> { field(&read(&self.directory, "cgroup.events")?, "populated").map(|value| value == 0) }
    pub fn cpu_micros(&self) -> io::Result<u64> { field(&read(&self.directory, "cpu.stat")?, "usage_usec") }

    pub fn remove(&self) -> io::Result<()> {
        if !self.empty()? { return Err(io::ErrorKind::WouldBlock.into()); }
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn open(directory: &File, name: &str, flags: i32) -> io::Result<File> {
    let name = CString::new(name).map_err(|_| io::ErrorKind::InvalidInput)?;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn read(directory: &File, name: &str) -> io::Result<String> {
    let mut bytes = Vec::new();
    open(directory, name, libc::O_RDONLY)?.take(8193).read_to_end(&mut bytes)?;
    if bytes.len() > 8192 { return Err(io::ErrorKind::InvalidData.into()); }
    String::from_utf8(bytes).map_err(|_| io::ErrorKind::InvalidData.into())
}

fn write(directory: &File, name: &str, value: &str) -> io::Result<()> {
    open(directory, name, libc::O_WRONLY)?.write_all(value.as_bytes())
}

fn field(value: &str, key: &str) -> io::Result<u64> {
    let mut matches = value.lines().filter_map(|line| line.split_once(' ').filter(|(name, _)| *name == key));
    let result = matches.next().ok_or(io::ErrorKind::InvalidData)?.1.parse::<u64>().map_err(|_| io::ErrorKind::InvalidData)?;
    if matches.next().is_some() { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::field;
    #[test]
    fn absence_and_ambiguous_kernel_projections_never_prove_empty() {
        assert_eq!(field("populated 0\nfrozen 0\n", "populated").unwrap(), 0);
        assert!(field("frozen 0\n", "populated").is_err());
        assert!(field("populated 0\npopulated 1\n", "populated").is_err());
        assert!(field("populated false\n", "populated").is_err());
        assert_eq!(field("usage_usec 123\nuser_usec 99\n", "usage_usec").unwrap(), 123);
    }
}
