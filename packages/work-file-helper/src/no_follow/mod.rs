// Adapted from OpenAI Codex exec-server; fixed provenance and changes are in UPSTREAM.json.
use std::{fs::File, io, path::Path};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use unix::{identity, stamp};
#[cfg(windows)]
pub use windows::{identity, stamp};
#[cfg(windows)]
pub use windows::{LockedPath, create_private_child, final_path};

pub fn open_root(path: &Path) -> io::Result<File> {
    #[cfg(unix)] { unix::open_root(path) }
    #[cfg(windows)] { windows::open_root(path) }
}

pub fn open_relative(root: &File, components: &[&str]) -> io::Result<File> {
    #[cfg(unix)] { unix::open_relative(root, components) }
    #[cfg(windows)] { windows::open_relative(root, components) }
}

pub fn relative(value: &str) -> io::Result<Vec<&str>> {
    if value.is_empty() || value.len() > 2048 || value.contains(['\\', ':']) || value.chars().any(char::is_control) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() > 32 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(parts)
}
