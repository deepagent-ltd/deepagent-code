//! Single payload with threads: clone3 returns ENOSYS for the runtime's pthread
//! fallback, while clone is allowed only with in-process thread flags.
use std::io;

const ALLOW: u32 = 0x7fff_0000;
const KILL: u32 = 0x8000_0000;
const ERRNO: u32 = 0x0005_0000;
// Linux UAPI asm-generic syscall 452; libc 0.2.186 lacks this constant on aarch64.
#[cfg(target_arch = "aarch64")]
const FCHMODAT2: libc::c_long = 452;
#[cfg(target_arch = "x86_64")]
const FCHMODAT2: libc::c_long = libc::SYS_fchmodat2;
const REQUIRED: u32 = (libc::CLONE_VM | libc::CLONE_SIGHAND | libc::CLONE_THREAD) as u32;
const ALLOWED: u32 = (libc::CLONE_VM | libc::CLONE_FS | libc::CLONE_FILES | libc::CLONE_SIGHAND | libc::CLONE_THREAD |
    libc::CLONE_SYSVSEM | libc::CLONE_SETTLS | libc::CLONE_PARENT_SETTID | libc::CLONE_CHILD_SETTID | libc::CLONE_CHILD_CLEARTID) as u32;

fn instruction(code: u16, jt: u8, jf: u8, k: u32) -> libc::sock_filter { libc::sock_filter { code, jt, jf, k } }

pub fn install() -> io::Result<()> {
    #[cfg(target_arch = "x86_64")]
    let arch = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    let arch = 0xc000_00b7;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Err(io::ErrorKind::Unsupported.into());
    let mut filters = vec![
        instruction(0x20, 0, 0, 4), instruction(0x15, 1, 0, arch), instruction(0x06, 0, 0, KILL),
        instruction(0x20, 0, 0, 0),
        // x32 is not the signed x86_64 runtime ABI and must not bypass syscall guards.
        instruction(0x35, 0, 1, 0x4000_0000), instruction(0x06, 0, 0, KILL),
        instruction(0x15, 0, 8, libc::SYS_clone as u32),
        instruction(0x20, 0, 0, 16), instruction(0x54, 0, 0, REQUIRED), instruction(0x15, 0, 3, REQUIRED),
        instruction(0x20, 0, 0, 16), instruction(0x54, 0, 0, !ALLOWED), instruction(0x15, 1, 0, 0),
        instruction(0x06, 0, 0, ERRNO | libc::EPERM as u32), instruction(0x06, 0, 0, ALLOW),
        instruction(0x20, 0, 0, 0),
        instruction(0x15, 0, 1, libc::SYS_clone3 as u32), instruction(0x06, 0, 0, ERRNO | libc::ENOSYS as u32),
    ];
    let mut denied = vec![libc::SYS_socket, libc::SYS_socketpair, libc::SYS_mount, libc::SYS_umount2, libc::SYS_pivot_root,
        libc::SYS_mount_setattr, libc::SYS_fsopen, libc::SYS_fsmount, libc::SYS_fsconfig, libc::SYS_fspick, libc::SYS_open_tree,
        libc::SYS_move_mount, libc::SYS_setns, libc::SYS_unshare, libc::SYS_ptrace, libc::SYS_process_vm_readv, libc::SYS_process_vm_writev,
        libc::SYS_bpf, libc::SYS_perf_event_open, libc::SYS_userfaultfd, libc::SYS_open_by_handle_at, libc::SYS_name_to_handle_at,
        libc::SYS_memfd_create, libc::SYS_fchmod, libc::SYS_fchmodat, libc::SYS_fchown,
        FCHMODAT2, libc::SYS_io_uring_setup, libc::SYS_io_uring_enter, libc::SYS_io_uring_register,
        libc::SYS_fchownat, libc::SYS_mknodat, libc::SYS_linkat, libc::SYS_symlinkat, libc::SYS_renameat, libc::SYS_renameat2,
        libc::SYS_unlinkat, libc::SYS_mkdirat, libc::SYS_reboot, libc::SYS_kexec_load, libc::SYS_init_module, libc::SYS_finit_module,
        libc::SYS_delete_module, libc::SYS_keyctl, libc::SYS_add_key, libc::SYS_request_key];
    #[cfg(target_arch = "x86_64")]
    denied.extend([libc::SYS_fork, libc::SYS_vfork, libc::SYS_mknod, libc::SYS_link, libc::SYS_symlink, libc::SYS_rename,
        libc::SYS_unlink, libc::SYS_mkdir, libc::SYS_rmdir, libc::SYS_lchown, libc::SYS_chmod, libc::SYS_chown]);
    for number in denied {
        filters.push(instruction(0x15, 0, 1, number as u32));
        filters.push(instruction(0x06, 0, 0, ERRNO | libc::EPERM as u32));
    }
    filters.push(instruction(0x06, 0, 0, ALLOW));
    let program = libc::sock_fprog { len: filters.len() as u16, filter: filters.as_mut_ptr() };
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, 2, &program) } != 0 { return Err(io::Error::last_os_error()); }
    Ok(())
}

pub fn drop_capabilities() -> io::Result<()> {
    #[repr(C)]
    struct Header { version: u32, pid: i32 }
    #[repr(C)]
    struct Data { effective: u32, permitted: u32, inheritable: u32 }
    // Drop all known capability bounding bits, including future bits exposed by
    // this kernel. EINVAL marks the first unsupported bit; other failures refuse.
    for capability in 0..64 {
        if unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) } != 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) { break; }
            return Err(io::Error::last_os_error());
        }
    }
    let header = Header { version: 0x2008_0522, pid: 0 };
    let data = [Data { effective: 0, permitted: 0, inheritable: 0 }, Data { effective: 0, permitted: 0, inheritable: 0 }];
    if unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) } != 0 { return Err(io::Error::last_os_error()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ALLOWED, REQUIRED};
    #[test]
    fn only_same_process_threads_pass_clone_filter() {
        assert_ne!(REQUIRED & libc::CLONE_THREAD as u32, 0);
        assert_eq!(REQUIRED & !ALLOWED, 0);
        assert_ne!((REQUIRED | libc::CLONE_NEWUSER as u32) & !ALLOWED, 0);
        assert_ne!((REQUIRED | libc::SIGCHLD as u32) & !ALLOWED, 0);
    }
}
