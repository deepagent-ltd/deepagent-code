//! In-process Windows bootstrap. Native image observations are not Work permits.
//! Registration captures before exposing any JavaScript-callable method; callers
//! cannot submit paths, hashes, PIDs or reconstructed handles to this module.
#[cfg(windows)]
#[path = "../protocol.rs"]
mod protocol;
#[cfg(windows)]
#[path = "../root.rs"]
mod root;
#[cfg(windows)]
#[path = "../snapshot.rs"]
mod snapshot;
#[cfg(windows)]
#[path = "../snapshot_windows.rs"]
mod snapshot_windows;
#[cfg(windows)]
#[path = "../no_follow/mod.rs"]
mod no_follow;
#[cfg(windows)]
#[path = "../regular_file.rs"]
mod regular_file;
#[cfg(windows)]
#[path = "../native_windows/mod.rs"]
mod native_windows;
#[cfg(windows)]
mod loader;
#[cfg(windows)]
mod napi;
#[cfg(windows)]
mod preload;
#[cfg(windows)]
mod installation;
#[cfg(windows)]
mod publisher;
#[cfg(windows)]
mod publisher_bridge;
#[cfg(windows)]
mod work_factory;
#[cfg(windows)]
mod event_git;
#[cfg(windows)]
mod event_git_protocol;
#[cfg(windows)]
mod event_git_namespace;
#[cfg(windows)]
mod event_git_bridge;
#[cfg(windows)]
#[path="../event_worktree.rs"]
mod event_worktree;
#[cfg(windows)]
mod work_bridge;
#[cfg(windows)]
mod work_process;
#[cfg(windows)]
mod work_child_bridge;
#[cfg(windows)]
mod work_workspace;
#[cfg(windows)]
mod work_workspace_bridge;
#[cfg(windows)]
mod work_command_cleanup;
#[cfg(windows)]
mod work_command_cleanup_bridge;
#[cfg(windows)]
mod windows_private_storage_bridge;
#[cfg(windows)]
pub(crate) use native_windows::private_directory;

#[cfg(windows)]
#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 { 8 }

#[cfg(windows)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(env: *mut std::ffi::c_void, exports: *mut std::ffi::c_void) -> *mut std::ffi::c_void {
    napi::register(env, exports, napi_register_module_v1 as *const std::ffi::c_void)
}

#[cfg(windows)]
#[path = "../command_supervisor/protocol.rs"]
mod command_protocol;
#[cfg(windows)]
mod work_command;
#[cfg(windows)]
mod work_command_bridge;

#[cfg(windows)]
mod work_command_phase;
