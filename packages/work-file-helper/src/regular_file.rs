// Adapted from OpenAI Codex exec-server/src/regular_file.rs (Apache-2.0).
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_DISK, GetFileType};

pub fn is_disk_file(file: &impl AsRawHandle) -> bool {
    // The owning File stays alive throughout this call.
    unsafe { GetFileType(file.as_raw_handle() as HANDLE) == FILE_TYPE_DISK }
}
