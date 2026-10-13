//! Windows bounded stream snapshot. The destination is an explicitly opened
//! private workspace; this operation never publishes into the live project.
use crate::{no_follow::{self, LockedPath}, native_windows::private_directory::{self, Descriptor},
    protocol::Identity, root::Root, snapshot::{Input, Snapshot}};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{self, Read, Write}, time::{Duration, Instant}};

pub fn prepare(root: &Root, workspace: &str, expected: &Identity, inputs: &[Input], outputs: &[String], deadline_ms: u64) -> io::Result<Snapshot> {
    if inputs.is_empty() || inputs.len() > 256 || outputs.len() > 32 || deadline_ms == 0 || deadline_ms > 30_000 ||
        inputs.iter().map(|value| value.relative.len()).sum::<usize>() + outputs.iter().map(String::len).sum::<usize>() > 8192 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    root.current()?;
    let source = LockedPath::open(&root.path, true, false)?;
    let target = LockedPath::open(std::path::Path::new(workspace), true, false)?;
    if no_follow::identity(&source.file)? != root.identity || no_follow::identity(&target.file)? != *expected ||
        target.canonical().starts_with(source.canonical()) || source.canonical().starts_with(target.canonical()) ||
        std::fs::read_dir(target.canonical())?.next().is_some() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    private_directory::require_private(&target.file)?;
    let mut names = BTreeSet::new();
    for name in inputs.iter().map(|value| value.relative.as_str()).chain(outputs.iter().map(String::as_str)) {
        let parts = no_follow::relative(name)?;
        if parts.len() > 16 || !names.insert(name) || parts.iter().any(|value| value.starts_with(".dac-")) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    for name in &names {
        let mut prefix = *name;
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            if names.contains(parent) { return Err(io::ErrorKind::InvalidInput.into()); }
            prefix = parent;
        }
    }
    let folded = names.iter().map(|name| name.to_uppercase()).collect::<BTreeSet<_>>();
    if folded.len() != names.len() || folded.iter().any(|name| {
        let mut prefix = name.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            if folded.contains(parent) { return true; }
            prefix = parent;
        }
        false
    }) { return Err(io::ErrorKind::InvalidInput.into()); }
    let limit = inputs.iter().try_fold(0u64, |total, input| {
        if input.bytes > 16_777_216 || input.sha256.len() != 64 || !input.sha256.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        total.checked_add(input.bytes).filter(|value| *value <= 67_108_864).ok_or(io::ErrorKind::InvalidInput.into())
    })?;
    let descriptor = Descriptor::current_user()?;
    let input_descriptor=Descriptor::command_input()?;
    let mut directories = BTreeMap::from([(String::new(), target.file.try_clone()?)]);
    let mut manifest = Sha256::new();
    manifest.update(b"dac-work-command-inputs.v1\0");
    let mut copied = 0u64;
    for input in inputs {
        check(deadline, &source, &target)?;
        let parts = no_follow::relative(&input.relative)?;
        let from = LockedPath::member(&source, &parts, false, false)?;
        let stamp = no_follow::stamp(&from.file)?;
        if no_follow::identity(&from.file)? != input.identity || from.file.metadata()?.len() != input.bytes {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut parent = parent(&mut directories, &parts, &descriptor)?;
        private_directory::require_private(&parent)?;
        let mut destination = no_follow::create_private_child(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, false, input_descriptor.pointer())?;
        private_directory::require_private(&destination)?;
        let mut file = from.file.try_clone()?;
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0; 65_536];
        loop {
            check(deadline, &source, &target)?;
            let count = file.read(&mut buffer)?;
            if count == 0 { break; }
            bytes = bytes.checked_add(count as u64).ok_or(io::ErrorKind::InvalidData)?;
            copied = copied.checked_add(count as u64).ok_or(io::ErrorKind::InvalidData)?;
            if bytes > input.bytes || copied > limit { return Err(io::ErrorKind::InvalidData.into()); }
            digest.update(&buffer[..count]); destination.write_all(&buffer[..count])?;
        }
        destination.sync_all()?;
        if bytes != input.bytes || format!("{:x}", digest.finalize()) != input.sha256 || no_follow::stamp(&from.file)? != stamp {
            return Err(io::ErrorKind::InvalidData.into());
        }
        from.current()?;
        drop(destination);
        parent.flush()?;
        let encoded = serde_json::to_vec(input)?;
        manifest.update((encoded.len() as u64).to_be_bytes()); manifest.update(encoded);
    }
    let output_descriptor = Descriptor::command_output()?;
    for output in outputs {
        check(deadline, &source, &target)?;
        let parts = no_follow::relative(output)?;
        let parent = parent(&mut directories, &parts, &descriptor)?;
        private_directory::require_private(&parent)?;
        let file = no_follow::create_private_child(&parent, parts.last().ok_or(io::ErrorKind::InvalidInput)?, false, output_descriptor.pointer())?;
        file.sync_all()?;
    }
    for name in [".dac-home", ".dac-tmp"] {
        let directory = no_follow::create_private_child(&target.file, name, true, descriptor.pointer())?;
        private_directory::require_private(&directory)?;
    }
    check(deadline, &source, &target)?;
    root.current()?;
    Ok(Snapshot { workspace: no_follow::identity(&target.file)?, manifest_sha256: format!("{:x}", manifest.finalize()),
        files: inputs.len(), bytes: copied, output_files: outputs.len() })
}

fn check(deadline: Instant, source: &LockedPath, target: &LockedPath) -> io::Result<()> {
    if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
    source.current()?; target.current()
}
fn parent(directories: &mut BTreeMap<String, File>, parts: &[&str], descriptor: &Descriptor) -> io::Result<File> {
    let mut prefix = String::new();
    for part in &parts[..parts.len()-1] {
        let key = if prefix.is_empty() { part.to_string() } else { format!("{prefix}/{part}") };
        if !directories.contains_key(&key) {
            let directory = no_follow::create_private_child(directories.get(&prefix).ok_or(io::ErrorKind::InvalidData)?, part, true, descriptor.pointer())?;
            private_directory::require_private(&directory)?;
            directories.insert(key.clone(), directory);
        }
        prefix = key;
    }
    directories.get(&prefix).ok_or(io::ErrorKind::InvalidData)?.try_clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_snapshot_copies_exact_bytes_and_rejects_wrong_identity_or_unprivate_destination() {
        let directory = std::env::temp_dir().join(format!("dac-snapshot-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let project = directory.join("project"); std::fs::create_dir(&project).unwrap();
        let content = b"private Windows snapshot \0 \xf0\x9f\x8c\x9f";
        std::fs::write(project.join("input.txt"), content).unwrap();
        let root = Root::inspect(project.to_str().unwrap()).unwrap();
        let destination = directory.join("workspace");
        let ancestor = no_follow::open_root(&directory).unwrap();
        let descriptor = Descriptor::current_user().unwrap();
        let target = no_follow::create_private_child(&ancestor, "workspace", true, descriptor.pointer()).unwrap();
        let identity = no_follow::identity(&target).unwrap(); drop(target);
        let input = Input { relative: "input.txt".into(), identity: no_follow::identity(&File::open(project.join("input.txt")).unwrap()).unwrap(),
            sha256: format!("{:x}", Sha256::digest(content)), bytes: content.len() as u64 };
        let receipt = prepare(&root, destination.to_str().unwrap(), &identity, &[input.clone()], &["out.txt".into()], 30_000).unwrap();
        assert_eq!(std::fs::read(destination.join("input.txt")).unwrap(), content);
        assert_eq!(std::fs::metadata(destination.join("out.txt")).unwrap().len(), 0);
        assert_eq!(receipt.files, 1); assert_eq!(receipt.bytes, content.len() as u64);
        assert!(prepare(&root, destination.to_str().unwrap(), &identity, &[input.clone()], &[], 30_000).is_err());
        let unsafe_target = directory.join("unsafe"); std::fs::create_dir(&unsafe_target).unwrap();
        let unsafe_identity = no_follow::identity(&no_follow::open_root(&unsafe_target).unwrap()).unwrap();
        assert!(prepare(&root, unsafe_target.to_str().unwrap(), &unsafe_identity, &[input], &[], 30_000).is_err());
        drop(ancestor); drop(root);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
