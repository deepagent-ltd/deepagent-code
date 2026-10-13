pub mod protocol;
mod common;
#[cfg(target_os = "linux")]
mod cgroup;
#[cfg(target_os = "linux")]
mod linux_namespace;
#[cfg(target_os = "linux")]
mod linux_seccomp;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows_job;
#[cfg(windows)]
mod windows_sentinel;
#[cfg(windows)]
mod windows_security;
#[cfg(windows)]
mod windows;

pub fn run(request: protocol::Run) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    return linux::run(request);
    #[cfg(windows)]
    return windows::run(request);
    #[cfg(not(any(target_os = "linux", windows)))]
    { let _ = request; Err(std::io::ErrorKind::Unsupported.into()) }
}

/// Fixed setup-only diagnostic. It never reads a Run, executes payload code,
/// returns a Work permit, or changes the caller's namespace.
pub fn probe_linux_namespaces() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    return linux_namespace::probe();
    #[cfg(not(target_os = "linux"))]
    Err(std::io::ErrorKind::Unsupported.into())
}
