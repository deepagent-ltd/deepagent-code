//! Explicit retirement of an authenticated, already-known private storage container.
//! This binary is independent of the execution helper and has no execution protocol.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{self, Read, Write}, path::Path,
    time::{SystemTime, UNIX_EPOCH}};

mod protocol {
    use serde::{Deserialize, Serialize};
    #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    pub enum Identity { Posix { device: String, inode: String } }
}
#[cfg(unix)]
#[path = "../no_follow/unix.rs"]
mod no_follow;
#[cfg(target_os = "linux")]
#[path = "../linux_write_profile.rs"]
mod linux_write_profile;
use protocol::Identity;

const MAX_FRAME: usize = 262144;
const MAX_FILE: u64 = 16777216;
const MAX_TOTAL: u64 = 67108864;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredFile { relative: String, identity: Identity, sha256: String, bytes: u64 }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDirectory { relative: String, identity: Identity }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Namespace {
    data: String, data_identity: Identity, project: String, project_identity: Identity,
    base: String, base_identity: Option<Identity>, basename: String, container_identity: Identity,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Inspect { version: u8, namespace: Namespace, allowed: Vec<String>, #[serde(rename = "deadlineMs")] deadline_ms: u64 },
    Cleanup { version: u8, namespace: Namespace, #[serde(rename = "cleanupID")] cleanup_id: String,
        #[serde(rename = "manifestHash")] manifest_hash: String, #[serde(rename = "planHash")] plan_hash: String,
        quarantine: String, files: Vec<StoredFile>, directories: Vec<StoredDirectory>,
        #[serde(rename = "jobKey")] job_key: String, #[serde(rename = "deadlineMs")] deadline_ms: u64 },
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof { version: u8, #[serde(rename = "cleanupID")] cleanup_id: String,
    manifest_hash: String, plan_hash: String, data_identity: Identity, base_identity: Identity,
    container_identity: Identity, quarantine: String, state: String, files: usize, observed_at: u64 }
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint { proof: Proof, mac: String }

fn now() -> io::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| invalid())?.as_millis().try_into().map_err(|_| invalid())?)
}
fn invalid() -> io::Error { io::ErrorKind::InvalidData.into() }
fn deadline(value: u64) -> io::Result<()> { let current = now()?;
    if current > value || value > current.saturating_add(30000) { return Err(io::ErrorKind::TimedOut.into()); } Ok(()) }
fn hash(value: &[u8]) -> String { format!("{:x}", Sha256::digest(value)) }
fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
fn text(value: &str) -> bool { !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control) }
fn relative(value: &str, root: bool) -> bool {
    (root && value.is_empty()) || (!value.is_empty() && value.len() <= 2048 && !value.contains(['\\', ':']) &&
        !value.chars().any(char::is_control) && value.split('/').count() <= 16 &&
        value.split('/').all(|p| !p.is_empty() && p != "." && p != ".."))
}
fn absolute(value: &str) -> bool { value.starts_with('/') && value.len() <= 2048 && relative(&value[1..], false) }
fn basename(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|v| v.len() == 32 && v.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}
fn identity_valid(value: &Identity) -> bool {
    let Identity::Posix { device, inode } = value;
    [device, inode].iter().all(|v| v.len() <= 20 && v.parse::<u64>().is_ok_and(|n| n.to_string() == **v))
}
fn key(value: &str) -> io::Result<[u8; 32]> {
    if !digest(value) { return Err(invalid()); }
    let mut out = [0; 32];
    for (i, v) in out.iter_mut().enumerate() { *v = u8::from_str_radix(&value[i*2..i*2+2], 16).map_err(|_| invalid())?; }
    Ok(out)
}
fn mac(key: &[u8; 32], value: &Proof) -> io::Result<String> {
    // SHA256 HMAC, fixed purpose; this key cannot authenticate Work or execution grants.
    let mut inner = [0x36; 64]; let mut outer = [0x5c; 64];
    for i in 0..32 { inner[i] ^= key[i]; outer[i] ^= key[i]; }
    let mut inside = Sha256::new(); inside.update(inner); inside.update(b"dac-work-storage-empty.v1\0");
    inside.update(serde_json::to_vec(&serde_json::to_value(value).map_err(|_| invalid())?).map_err(|_| invalid())?);
    let mut outside = Sha256::new(); outside.update(outer); outside.update(inside.finalize());
    Ok(format!("{:x}", outside.finalize()))
}
fn equal(a: &str, b: &str) -> bool { a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |v, (x,y)| v | (x ^ y)) == 0 }

#[cfg(unix)]
mod unix {
    use super::*;
    use rustix::fs::{self, AtFlags, Dir, Mode, OFlags, RenameFlags};
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    fn private(file: &File, strict: bool) -> io::Result<()> {
        let m = file.metadata()?;
        if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & if strict { 0o077 } else { 0o022 } != 0 {
            return Err(invalid());
        }
        Ok(())
    }
    fn directory(parent: &File, name: &str) -> io::Result<File> {
        Ok(File::from(fs::openat(parent, name, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())?))
    }
    fn optional(parent: &File, name: &str) -> io::Result<Option<File>> {
        match directory(parent, name) { Ok(v) => Ok(Some(v)), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e) }
    }
    fn at(root: &File, relative: &str) -> io::Result<File> {
        let mut current = root.try_clone()?;
        for part in relative.split('/').filter(|v| !v.is_empty()) { current = directory(&current, part)?; }
        Ok(current)
    }
    fn names(dir: &File) -> io::Result<Vec<String>> {
        let mut values = Vec::new();
        for entry in Dir::read_from(dir)? {
            let entry = entry?; let name = entry.file_name().to_str().map_err(|_| invalid())?;
            if name == "." || name == ".." { continue; }
            if !relative(name, false) || name.contains('/') || values.len() >= 4898 { return Err(invalid()); }
            values.push(name.to_owned());
        }
        values.sort(); Ok(values)
    }
    fn named_identity(parent: &File, name: &str, expected: &Identity, is_dir: bool) -> io::Result<()> {
        let file = if is_dir { directory(parent, name)? } else { no_follow::open_relative(parent, &[name])? };
        if no_follow::identity(&file)? != *expected { return Err(invalid()); }
        Ok(())
    }
    fn namespace(value: &Namespace) -> io::Result<(File, File)> {
        if !absolute(&value.data) || !absolute(&value.project) ||
            Path::new(&value.data).starts_with(&value.project) ||
            Path::new(&value.data).join(&value.base).starts_with(&value.project) ||
            Path::new(&value.project).starts_with(Path::new(&value.data).join(&value.base)) ||
            !matches!(value.base.as_str(), "work-write-stage" | "work-command-stage") ||
            !basename(&value.basename, if value.base == "work-command-stage" { "cmd_" } else { "" }) ||
            !identity_valid(&value.data_identity) || !identity_valid(&value.project_identity) || !identity_valid(&value.container_identity) {
            return Err(invalid());
        }
        let project = no_follow::open_root(Path::new(&value.project))?;
        if no_follow::identity(&project)? != value.project_identity { return Err(invalid()); }
        let data = no_follow::open_root(Path::new(&value.data))?;
        private(&data, false)?;
        if no_follow::identity(&data)? != value.data_identity { return Err(invalid()); }
        let base = directory(&data, &value.base)?; private(&base, true)?;
        if value.base_identity.as_ref().is_some_and(|id| no_follow::identity(&base).ok().as_ref() != Some(id)) ||
            base.metadata()?.dev() != data.metadata()?.dev() { return Err(invalid()); }
        named_identity(&data, &value.base, &no_follow::identity(&base)?, true)?;
        Ok((data, base))
    }
    fn file(root: &File, path: &str, until: u64) -> io::Result<StoredFile> {
        deadline(until)?;
        let mut value = no_follow::open_relative(root, &path.split('/').collect::<Vec<_>>())?;
        let before = no_follow::stamp(&value)?; let m = value.metadata()?;
        if m.uid() != unsafe { libc::geteuid() } || m.dev() != root.metadata()?.dev() || m.len() > MAX_FILE { return Err(invalid()); }
        let mut sha = Sha256::new(); let mut total = 0; let mut buf = [0; 65536];
        loop { deadline(until)?; let len = value.read(&mut buf)?; if len == 0 { break; } total += len as u64;
            if total > MAX_FILE { return Err(invalid()); } sha.update(&buf[..len]); }
        if no_follow::stamp(&value)? != before || total != m.len() { return Err(invalid()); }
        let result = StoredFile { relative: path.into(), identity: no_follow::identity(&value)?, sha256: format!("{:x}", sha.finalize()), bytes: total };
        let (leaf, parents) = path.rsplit_once('/').map_or((path, ""), |(p,l)| (l,p));
        named_identity(&at(root, parents)?, leaf, &result.identity, false)?;
        Ok(result)
    }
    fn inventory(root: &File, until: u64) -> io::Result<(Vec<StoredFile>, Vec<StoredDirectory>)> {
        let mut files = Vec::new(); let mut dirs = Vec::new(); let mut pending = vec![String::new()];
        while let Some(path) = pending.pop() {
            deadline(until)?; if dirs.len() >= 4610 { return Err(invalid()); }
            let dir = at(root, &path)?; private(&dir, true)?;
            if dir.metadata()?.dev() != root.metadata()?.dev() { return Err(invalid()); }
            dirs.push(StoredDirectory { relative: path.clone(), identity: no_follow::identity(&dir)? });
            for name in names(&dir)? {
                let child = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
                if !relative(&child, false) { return Err(invalid()); }
                let metadata = fs::statat(&dir, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)?;
                if fs::FileType::from_raw_mode(metadata.st_mode) == fs::FileType::Directory { pending.push(child); continue; }
                if files.len() >= 288 { return Err(invalid()); }
                files.push(file(root, &child, until)?);
            }
        }
        if files.iter().map(|v| v.bytes).sum::<u64>() > MAX_TOTAL { return Err(invalid()); }
        files.sort_by(|a,b| a.relative.cmp(&b.relative)); dirs.sort_by(|a,b| a.relative.cmp(&b.relative));
        Ok((files, dirs))
    }
    fn anchors(data: &File, base: &File, value: &Namespace) -> io::Result<()> {
        let actual = no_follow::open_root(Path::new(&value.data))?;
        if no_follow::identity(&actual)? != no_follow::identity(data)? { return Err(invalid()); }
        named_identity(data, &value.base, &no_follow::identity(base)?, true)
    }
    pub(super) fn inspect(value: Namespace, allowed: Vec<String>, until: u64) -> io::Result<serde_json::Value> {
        deadline(until)?; if allowed.len() > 288 || allowed.iter().any(|v| !relative(v, false)) { return Err(invalid()); }
        let (data, base) = namespace(&value)?; let root = directory(&base, &value.basename)?;
        private(&root, true)?;
        if no_follow::identity(&root)? != value.container_identity { return Err(invalid()); }
        let (files, directories) = inventory(&root, until)?;
        let expected: BTreeSet<_> = allowed.iter().collect();
        if files.len() != expected.len() || files.iter().any(|v| !expected.contains(&v.relative)) { return Err(invalid()); }
        named_identity(&base, &value.basename, &value.container_identity, true)?; anchors(&data, &base, &value)?;
        Ok(serde_json::json!({ "dataIdentity": no_follow::identity(&data)?, "baseIdentity": no_follow::identity(&base)?,
            "containerIdentity": no_follow::identity(&root)?, "files": files, "directories": directories }))
    }
    fn checkpoint(base: &File, name: &str, key: &[u8;32]) -> io::Result<Option<Checkpoint>> {
        let mut file = match no_follow::open_relative(base, &[name]) {
            Ok(file) => file, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None), Err(e) => return Err(e),
        };
        let m = file.metadata()?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.len() > 16384 { return Err(invalid()); }
        let mut bytes = Vec::new(); Read::by_ref(&mut file).take(16385).read_to_end(&mut bytes)?;
        let value: Checkpoint = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if !digest(&value.mac) || !equal(&mac(key, &value.proof)?, &value.mac) { return Err(invalid()); }
        Ok(Some(value))
    }
    fn save(base: &File, name: &str, value: &Checkpoint, key: &[u8;32]) -> io::Result<()> {
        if let Some(existing) = checkpoint(base, name, key)? {
            if existing.proof != value.proof || existing.mac != value.mac { return Err(invalid()); }
            return Ok(());
        }
        let temp = format!("{name}.tmp");
        let mut file = match fs::openat(base, temp.as_str(), OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600)) {
            Ok(fd) => File::from(fd), Err(e) if e == rustix::io::Errno::EXIST => {
                let old = checkpoint(base, &temp, key)?.ok_or_else(invalid)?;
                if old.proof != value.proof || old.mac != value.mac { return Err(invalid()); }
                fs::renameat_with(base, temp.as_str(), base, name, RenameFlags::NOREPLACE)?; base.sync_all()?; return Ok(());
            }, Err(e) => return Err(e.into()),
        };
        file.write_all(&serde_json::to_vec(&serde_json::to_value(value).map_err(|_| invalid())?).map_err(|_| invalid())?)?;
        file.sync_all()?; fs::renameat_with(base, temp.as_str(), base, name, RenameFlags::NOREPLACE)?; base.sync_all()?;
        Ok(())
    }
    fn lock(base: &File) -> io::Result<File> {
        let file = File::from(fs::openat(base, ".cleanup-lock", OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600))?);
        let m = file.metadata()?;
        if !m.is_file() || m.nlink() != 1 || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 { return Err(invalid()); }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(io::Error::last_os_error()); }
        Ok(file)
    }
    pub(super) fn cleanup(value: Namespace, cleanup_id: String, manifest_hash: String, plan_hash: String,
        quarantine: String, files: Vec<StoredFile>, directories: Vec<StoredDirectory>, job_key: String, until: u64) -> io::Result<serde_json::Value> {
        deadline(until)?;
        if !text(&cleanup_id) || !digest(&manifest_hash) || !digest(&plan_hash) || !basename(&quarantine, "cleanup_") ||
            value.base_identity.is_none() || files.len() > 288 || directories.len() > 4610 ||
            files.iter().any(|v| !relative(&v.relative, false) || !identity_valid(&v.identity) || !digest(&v.sha256) || v.bytes > MAX_FILE) ||
            directories.iter().any(|v| !relative(&v.relative, true) || !identity_valid(&v.identity)) ||
            !directories.iter().any(|v| v.relative.is_empty() && v.identity == value.container_identity) ||
            files.iter().map(|v| v.bytes).sum::<u64>() > MAX_TOTAL { return Err(invalid()); }
        let expected_files: BTreeMap<_,_> = files.iter().map(|v| (&v.relative,v)).collect();
        let expected_dirs: BTreeMap<_,_> = directories.iter().map(|v| (&v.relative,v)).collect();
        if expected_files.len() != files.len() || expected_dirs.len() != directories.len() { return Err(invalid()); }
        let mut key = key(&job_key)?; let (data, base) = namespace(&value)?; let _lock = lock(&base)?;
        let marker = format!("proof_{}.json", hash(cleanup_id.as_bytes()));
        let prior = checkpoint(&base, &marker, &key)?.or(checkpoint(&base, &format!("{marker}.tmp"), &key)?);
        let original = optional(&base, &value.basename)?; let quarantined = optional(&base, &quarantine)?;
        if original.is_some() && quarantined.is_some() { return Err(invalid()); }
        let root = match (original, quarantined) {
            (Some(root), None) => {
                if prior.is_some() || no_follow::identity(&root)? != value.container_identity { return Err(invalid()); }
                fs::renameat_with(&base, value.basename.as_str(), &base, quarantine.as_str(), RenameFlags::NOREPLACE)?;
                base.sync_all()?;
                // Rename first, then validate again; a swapped namespace entry is retained,
                // never recursively removed or treated as the authenticated container.
                named_identity(&base, &quarantine, &value.container_identity, true)?;
                Some(root)
            },
            (None, Some(root)) => { if no_follow::identity(&root)? != value.container_identity { return Err(invalid()); } Some(root) },
            (None, None) => None,
            _ => return Err(invalid()),
        };
        let expected = Proof { version: 1, cleanup_id, manifest_hash, plan_hash, data_identity: value.data_identity.clone(),
            base_identity: no_follow::identity(&base)?, container_identity: value.container_identity.clone(), quarantine: quarantine.clone(),
            state: "empty_verified".into(), files: files.len(), observed_at: prior.as_ref().map_or(now()?, |v| v.proof.observed_at) };
        if let Some(prior) = &prior { if prior.proof != expected { return Err(invalid()); } }
        if let Some(root) = root {
            private(&root, true)?; let (present_files, present_dirs) = inventory(&root, until)?;
            if present_files.iter().any(|v| expected_files.get(&v.relative).is_none_or(|e| **e != *v)) ||
                present_dirs.iter().any(|v| expected_dirs.get(&v.relative).is_none_or(|e| **e != *v)) ||
                (prior.is_some() && (!present_files.is_empty() || present_dirs.len() != 1)) { return Err(invalid()); }
            for stored in present_files {
                deadline(until)?; if file(&root, &stored.relative, until)? != stored { return Err(invalid()); }
                let (leaf, parent) = stored.relative.rsplit_once('/').map_or((stored.relative.as_str(), ""), |(p,l)| (l,p));
                let fd = at(&root, parent)?; named_identity(&fd, leaf, &stored.identity, false)?;
                fs::unlinkat(&fd, leaf, AtFlags::empty())?; fd.sync_all()?;
            }
            let mut remaining: Vec<_> = present_dirs.into_iter().filter(|v| !v.relative.is_empty()).collect();
            remaining.sort_by(|a,b| b.relative.split('/').count().cmp(&a.relative.split('/').count()).then(b.relative.cmp(&a.relative)));
            for stored in remaining {
                deadline(until)?;
                let (leaf, parent) = stored.relative.rsplit_once('/').map_or((stored.relative.as_str(), ""), |(p,l)| (l,p));
                let fd = at(&root, parent)?; named_identity(&fd, leaf, &stored.identity, true)?;
                fs::unlinkat(&fd, leaf, AtFlags::REMOVEDIR)?; fd.sync_all()?;
            }
            if !names(&root)?.is_empty() { return Err(invalid()); }
            root.sync_all()?; anchors(&data, &base, &value)?;
            let proof = Checkpoint { mac: mac(&key, &expected)?, proof: expected.clone() };
            save(&base, &marker, &proof, &key)?;
            named_identity(&base, &quarantine, &value.container_identity, true)?;
            fs::unlinkat(&base, quarantine.as_str(), AtFlags::REMOVEDIR)?; base.sync_all()?;
        } else if prior.is_none() { return Err(invalid()); }
        if optional(&base, &quarantine)?.is_some() || optional(&base, &value.basename)?.is_some() { return Err(invalid()); }
        anchors(&data, &base, &value)?;
        let output = serde_json::to_value(Checkpoint { mac: mac(&key, &expected)?, proof: expected }).map_err(|_| invalid())?;
        key.fill(0); Ok(output)
    }
}

fn run(request: Request) -> io::Result<serde_json::Value> {
    #[cfg(target_os = "linux")]
    let inspection = matches!(&request, Request::Inspect { .. });
    #[cfg(target_os = "linux")]
    let profile = match &request {
        Request::Inspect { namespace, .. } | Request::Cleanup { namespace, .. } if namespace.base == "work-write-stage" =>
            Some(linux_write_profile::Profile::enter(&namespace.project, &namespace.data)?),
        _ => None,
    };
    #[cfg(target_os = "linux")]
    if let Some(profile) = &profile { profile.current()?; }
    #[cfg(unix)]
    { let result = match request {
        Request::Inspect { version: 1, namespace, allowed, deadline_ms } => unix::inspect(namespace, allowed, deadline_ms),
        Request::Cleanup { version: 1, namespace, cleanup_id, manifest_hash, plan_hash, quarantine, files, directories, job_key, deadline_ms } =>
            unix::cleanup(namespace, cleanup_id, manifest_hash, plan_hash, quarantine, files, directories, job_key, deadline_ms),
        _ => Err(invalid()),
    };
    #[cfg(target_os = "linux")]
    if let Some(profile) = &profile { profile.current()?; }
    result.map(|mut value| {
        #[cfg(target_os = "linux")]
        if inspection {
            if let Some(profile) = profile { value["linuxWriteProfile"] = serde_json::to_value(profile.description).unwrap(); }
        }
        value
    }) }
    #[cfg(not(unix))]
    { let _ = request; Err(io::ErrorKind::Unsupported.into()) }
}
fn main() {
    let result = (|| {
        let mut frame = Vec::new(); io::stdin().take((MAX_FRAME + 1) as u64).read_to_end(&mut frame)?;
        if frame.len() > MAX_FRAME { return Err(invalid()); }
        let request = serde_json::from_slice(&frame).map_err(|_| invalid())?;
        frame.fill(0);
        run(request)
    })();
    match result {
        Ok(value) => { let bytes = serde_json::to_vec(&value).unwrap_or_default();
            if bytes.len() > 131072 || io::stdout().write_all(&bytes).is_err() { std::process::exit(2); } },
        Err(error) => { eprintln!("storage cleanup retains custody: {:?}", error.kind()); std::process::exit(1); },
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::{fs::{PermissionsExt, symlink}, fs::MetadataExt}};
    fn case(name: &str) -> (String, String, Namespace) {
        let root = std::env::temp_dir().join(format!("dac-cleanup-{name}-{}-{}", std::process::id(), now().unwrap()));
        fs::create_dir(&root).unwrap(); fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let data = root.join("data"); let project = root.join("project");
        fs::create_dir(&data).unwrap(); fs::create_dir(&project).unwrap();
        let base = data.join("work-command-stage"); fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let container = base.join("cmd_0123456789abcdef0123456789abcdef"); fs::create_dir(&container).unwrap();
        fs::set_permissions(&container, fs::Permissions::from_mode(0o700)).unwrap();
        let id = |path: &Path| { let m = fs::metadata(path).unwrap(); Identity::Posix { device: m.dev().to_string(), inode: m.ino().to_string() } };
        let namespace = Namespace { data: data.to_string_lossy().into(), data_identity: id(&data),
            project: project.to_string_lossy().into(), project_identity: id(&project), base: "work-command-stage".into(),
            base_identity: Some(id(&base)), basename: "cmd_0123456789abcdef0123456789abcdef".into(), container_identity: id(&container) };
        (root.to_string_lossy().into(), container.to_string_lossy().into(), namespace)
    }
    fn copy(value: &Namespace) -> Namespace { Namespace { data: value.data.clone(), data_identity: value.data_identity.clone(),
        project: value.project.clone(), project_identity: value.project_identity.clone(), base: value.base.clone(),
        base_identity: value.base_identity.clone(), basename: value.basename.clone(), container_identity: value.container_identity.clone() } }
    fn inspect(value: &Namespace, allowed: Vec<String>) -> (Vec<StoredFile>, Vec<StoredDirectory>) {
        let result = unix::inspect(copy(value), allowed, now().unwrap()+10000).unwrap();
        (serde_json::from_value(result["files"].clone()).unwrap(), serde_json::from_value(result["directories"].clone()).unwrap())
    }
    fn cleanup(value: &Namespace, files: Vec<StoredFile>, dirs: Vec<StoredDirectory>) -> io::Result<serde_json::Value> {
        unix::cleanup(copy(value), "clean-test".into(), "a".repeat(64), "b".repeat(64),
            "cleanup_0123456789abcdef0123456789abcdef".into(), files, dirs, "c".repeat(64), now()?+10000)
    }
    #[test]
    fn sibling_event_worktree_uses_fixed_storage_namespace_without_touching_project() {
        let (root, container, mut value) = case("event-worktree");
        let project=Path::new(&value.data).join("worktree");fs::create_dir(&project).unwrap();
        let metadata=fs::metadata(&project).unwrap();value.project=project.to_string_lossy().into();
        value.project_identity=Identity::Posix{device:metadata.dev().to_string(),inode:metadata.ino().to_string()};
        fs::write(project.join("original.ts"),b"preserve original project").unwrap();
        fs::write(Path::new(&container).join("input.ts"),b"owned staged input").unwrap();
        let(files,dirs)=inspect(&value,vec!["input.ts".into()]);assert_eq!(files.len(),1);
        cleanup(&value,files,dirs).unwrap();assert!(!Path::new(&container).exists());
        assert_eq!(fs::read(project.join("original.ts")).unwrap(),b"preserve original project");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn project_inside_fixed_stage_or_its_ancestor_remains_unavailable() {
        let(root,container,value)=case("event-overlap");
        fs::write(Path::new(&container).join("input.ts"),b"preserve staged input").unwrap();
        for project in [value.data.clone(),Path::new(&value.data).join(&value.base).to_string_lossy().into(),container.clone()] {
            let mut overlapping=copy(&value);let metadata=fs::metadata(&project).unwrap();
            overlapping.project=project;overlapping.project_identity=Identity::Posix{device:metadata.dev().to_string(),inode:metadata.ino().to_string()};
            assert!(unix::inspect(overlapping,vec!["input.ts".into()],now().unwrap()+10000).is_err());
            assert_eq!(fs::read(Path::new(&container).join("input.ts")).unwrap(),b"preserve staged input");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn known_files_checkpoint_survives_cold_exact_retry() {
        let (root, container, value) = case("known");
        fs::write(Path::new(&container).join("input.ts"), b"const n=1").unwrap();
        let (files, dirs) = inspect(&value, vec!["input.ts".into()]);
        let first = cleanup(&value, files.clone(), dirs.clone()).unwrap();
        assert!(!Path::new(&container).exists());
        let second = cleanup(&value, files, dirs).unwrap(); assert_eq!(first, second);
        let proof: Proof = serde_json::from_value(first["proof"].clone()).unwrap();
        assert_eq!(first["mac"].as_str().unwrap(), mac(&key(&"c".repeat(64)).unwrap(), &proof).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn foreign_file_retains_then_exact_partial_retry_uses_original_plan() {
        let (root, container, value) = case("partial");
        fs::write(Path::new(&container).join("input.ts"), b"owned").unwrap();
        let (files, dirs) = inspect(&value, vec!["input.ts".into()]);
        fs::write(Path::new(&container).join("foreign"), b"preserve").unwrap();
        assert!(cleanup(&value, files.clone(), dirs.clone()).is_err());
        let quarantine = Path::new(&value.data).join(&value.base).join("cleanup_0123456789abcdef0123456789abcdef");
        assert_eq!(fs::read(quarantine.join("foreign")).unwrap(), b"preserve");
        fs::remove_file(quarantine.join("foreign")).unwrap();
        // Simulate the already-authorized file unlink becoming durable before a crash.
        fs::remove_file(quarantine.join("input.ts")).unwrap();
        assert!(cleanup(&value, files, dirs).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlink_and_bare_absence_never_prove_deletion() {
        let (root, container, value) = case("symlink");
        fs::write(Path::new(&value.project).join("private"), b"preserve").unwrap();
        symlink(Path::new(&value.project).join("private"), Path::new(&container).join("input.ts")).unwrap();
        assert!(unix::inspect(copy(&value), vec!["input.ts".into()], now().unwrap()+10000).is_err());
        assert_eq!(fs::read(Path::new(&value.project).join("private")).unwrap(), b"preserve");
        fs::remove_file(Path::new(&container).join("input.ts")).unwrap();
        let (files, dirs) = inspect(&value, vec![]); fs::remove_dir(&container).unwrap();
        assert!(cleanup(&value, files, dirs).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replaced_container_identity_never_deletes_foreign_directory() {
        let (root, container, value) = case("identity"); let (files, dirs) = inspect(&value, vec![]);
        fs::rename(&container, format!("{container}-preserved")).unwrap();
        fs::create_dir(&container).unwrap(); fs::set_permissions(&container, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(Path::new(&container).join("foreign"), b"preserve").unwrap();
        assert!(cleanup(&value, files, dirs).is_err());
        assert_eq!(fs::read(Path::new(&container).join("foreign")).unwrap(), b"preserve");
        fs::remove_dir_all(root).unwrap();
    }
}
