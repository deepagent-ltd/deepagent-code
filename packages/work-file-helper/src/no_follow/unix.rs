// Adapted from OpenAI Codex exec-server/src/no_follow/unix.rs (Apache-2.0).
use crate::protocol::Identity;
use rustix::fs::{Mode, OFlags, open, openat};
use std::{fs::File, io, os::unix::fs::MetadataExt, path::{Component, Path}};

fn directory_flags() -> OFlags {
    #[cfg(target_os = "linux")]
    { OFlags::PATH }
    #[cfg(target_vendor = "apple")]
    { OFlags::from_bits_retain(libc::O_SEARCH as u32) }
    #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
    { OFlags::RDONLY }
}

pub fn open_root(path: &Path) -> io::Result<File> {
    if !path.is_absolute() { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut current = File::from(open("/", directory_flags() | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?);
    for part in path.components() {
        match part {
            Component::RootDir => {},
            Component::Normal(name) => current = File::from(openat(&current, name,
                directory_flags() | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?),
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        }
    }
    Ok(current)
}

pub fn open_relative(root: &File, parts: &[&str]) -> io::Result<File> {
    let (leaf, parents) = parts.split_last().ok_or(io::ErrorKind::InvalidInput)?;
    let mut current = root.try_clone()?;
    for part in parents {
        current = File::from(openat(&current, *part,
            directory_flags() | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?);
    }
    let file = File::from(openat(&current, *leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 { return Err(io::ErrorKind::InvalidInput.into()); }
    Ok(file)
}

pub fn identity(file: &File) -> io::Result<Identity> {
    let value = file.metadata()?;
    Ok(Identity::Posix { device: value.dev().to_string(), inode: value.ino().to_string() })
}

pub fn stamp(file: &File) -> io::Result<String> {
    let value = file.metadata()?;
    Ok(format!("{}:{}:{}:{}:{}:{}:{}:{}:{}", value.dev(), value.ino(), value.len(), value.mode(),
        value.nlink(), value.mtime(), value.mtime_nsec(), value.ctime(), value.ctime_nsec()))
}
