//! Known immutable artifact collection. This preserves the original worktree
//! registration and removes only members proved by the complete Native stream.
use crate::{event_worktree::{self, windows_observation, ObservedTree}, no_follow::{self, LockedPath},
    native_windows::private_directory, root::Root};
use super::Failure;
use std::{collections::BTreeMap, fs::File, io, time::{Duration, Instant}};

pub(super) fn clear(root: &Root, files: u64, bytes: u64, manifest: &str, deadline_ms: u64) -> Result<u64, Failure> {
    let changed = std::cell::Cell::new(false);
    let result = (|| -> io::Result<u64> {
        if files > event_worktree::FILES || bytes > event_worktree::BYTES || deadline_ms == 0 || deadline_ms > event_worktree::DEADLINE_MS {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        let locked = LockedPath::open(&root.path, true, false)?;
        if no_follow::identity(&locked.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        private_directory::require_private(&locked.file)?;
        let pointer_lease = LockedPath::member(&locked, &[".git"], false, false)?;
        let pointer = &pointer_lease.file;
        if pointer.metadata()?.len() == 0 || pointer.metadata()?.len() > 8192 { return Err(io::ErrorKind::InvalidData.into()); }
        let pointer_stamp = no_follow::stamp(&pointer)?;
        let mut pending = vec![(String::new(), root.file.try_clone()?)];
        let mut directories = BTreeMap::<String, (File, String)>::new();
        let mut members = BTreeMap::<String, (File, String)>::new();
        let mut entries = 0usize;
        while let Some((prefix, parent)) = pending.pop() {
            locked.current()?; root.current()?;
            for (name, directory) in windows_observation::names(&parent, deadline)? {
                if prefix.is_empty() && name == ".git" && !directory { continue; }
                entries += 1;
                if entries > event_worktree::FILES as usize + event_worktree::DIRECTORIES { return Err(io::ErrorKind::InvalidInput.into()); }
                let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                no_follow::relative(&relative)?;
                if relative.split('/').count() > 32 || name.eq_ignore_ascii_case(".git") || name.starts_with(".dac-tree-") {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                // These retained DELETE handles exclude preexisting writers and
                // future namespace replacement until the original GC retires.
                let file = windows_observation::deleting(&parent, &name, directory)?;
                private_directory::require_private(&file)?;
                let stamp = no_follow::stamp(&file)?;
                if directory {
                    if directories.len() >= event_worktree::DIRECTORIES { return Err(io::ErrorKind::InvalidInput.into()); }
                    pending.push((relative.clone(), file.try_clone()?));
                    if directories.insert(relative, (file, stamp)).is_some() { return Err(io::ErrorKind::InvalidData.into()); }
                    continue;
                }
                if members.len() >= event_worktree::FILES as usize || members.insert(relative, (file, stamp)).is_some() {
                    return Err(io::ErrorKind::InvalidData.into());
                }
            }
        }
        let mut observed = ObservedTree::begin(root, deadline_ms)?;
        for relative in members.keys() { observed.leaf(root, relative)?; }
        let receipt = observed.finish(root)?;
        if receipt.files != files || receipt.bytes != bytes || receipt.manifest_sha256 != manifest { return Err(io::ErrorKind::InvalidData.into()); }
        // Complete identities/stamps and the unchanged registration precede the
        // first mutation. No partial result can be upgraded to known success.
        for (relative, (file, stamp)) in &members { windows_observation::current_member(root, relative, file, stamp, false)?; }
        for (relative, (file, stamp)) in &directories { windows_observation::current_member(root, relative, file, stamp, true)?; }
        for (relative, (file, stamp)) in members {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            locked.current()?; root.current()?; pointer_current(root, &pointer, &pointer_stamp)?;
            windows_observation::current_member(root, &relative, &file, &stamp, false)?;
            private_directory::require_private(&file)?; changed.set(true);
            crate::write_windows::dispose(&file)?;
            if crate::write_windows::accessible_links(&file)? != 0 { return Err(io::ErrorKind::InvalidData.into()); }
            // An original DELETE object may keep the removed name DeletePending
            // until it closes. Prove its original link retirement before dropping
            // just this member; all remaining members/ancestors stay held.
            drop(file);
            absent(root, &relative, false)?;
        }
        for (relative, (file, _)) in directories.into_iter().rev() {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            locked.current()?; root.current()?; pointer_current(root, &pointer, &pointer_stamp)?;
            private_directory::require_private(&file)?;
            let parts = no_follow::relative(&relative)?;
            let parent = windows_observation::directory(root, &parts[..parts.len()-1])?;
            let actual = windows_observation::member(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, true)?;
            if no_follow::identity(&actual)? != no_follow::identity(&file)? || !windows_observation::names(&file, deadline)?.is_empty() {
                return Err(io::ErrorKind::InvalidData.into());
            }
            drop(actual); drop(parent); changed.set(true); crate::write_windows::dispose(&file)?; drop(file);
            absent(root, &relative, true)?;
        }
        locked.current()?; root.current()?; pointer_current(root, &pointer, &pointer_stamp)?;
        let empty = ObservedTree::begin(root, deadline_ms)?.finish(root)?;
        Ok(empty.allocated_bytes)
    })();
    result.map_err(|_| if changed.get() { Failure::Unknown } else { Failure::BeforeMutation })
}
fn pointer_current(root: &Root, file: &File, stamp: &str) -> io::Result<()> {
    windows_observation::current_member(root, ".git", file, stamp, false)
}
fn absent(root: &Root, relative: &str, directory: bool) -> io::Result<()> {
    let parts = no_follow::relative(relative)?;
    let parent = windows_observation::directory(root, &parts[..parts.len()-1])?;
    match windows_observation::member(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()), _ => Err(io::ErrorKind::InvalidData.into()),
    }
}
