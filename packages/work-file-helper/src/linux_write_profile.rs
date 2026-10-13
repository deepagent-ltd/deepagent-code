//! Ordinary-UID observation of the package-owned project write policy.
//! Policy names/JSON do not grant Work authority. The Host keeps its original
//! signed inventory, source, permission and budget checks around this producer.
use crate::{no_follow, protocol::Identity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File}, io::{self, Read, Write}, os::unix::fs::MetadataExt,
    path::{Path, PathBuf}, time::{Duration, Instant}};

const MAX_BYTES: u64 = 16_777_216;
const RECORD_BYTES: u64 = 16_384;
const INVENTORY_BYTES: usize = 1_048_576;
const SUFFIX: &str = "/resources/app.asar.unpacked/out/main/chunks/deepagent-work-file-helper";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation { domain: String, target: String, prefix: String, helper: String,
    helper_bytes: u64, #[serde(rename = "helperSHA256")] helper_sha256: String }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope { domain: String, helper: String, #[serde(rename = "helperSHA256")] helper_sha256: String, uid: u32,
    project: String, data: String }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record { domain: String, target: String, scope: Scope, profile: String,
    #[serde(rename = "profileSHA256")] profile_sha256: String, project_identity: Identity, data_identity: Identity,
    native_authority: bool }
#[derive(Clone, Debug, Serialize)]
pub struct Description { pub profile: String, pub profile_sha256: String, pub helper_sha256: String,
    pub project_identity: Identity, pub data_identity: Identity, pub enforced: bool }

pub struct Profile { uid: u32, pub description: Description, project: PathBuf, data: PathBuf,
    project_file: File, data_file: File, retained: Vec<(File, String)> }

fn refused() -> io::Error { io::ErrorKind::PermissionDenied.into() }
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn digest(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn target() -> &'static str {
    if cfg!(target_arch = "x86_64") { "linux-x64" } else { "linux-arm64" }
}
fn until(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
    Ok(())
}

fn owned_directory(path: &Path) -> io::Result<File> {
    let mut current = PathBuf::from("/");
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {},
            std::path::Component::Normal(name) => current.push(name),
            _ => return Err(refused()),
        }
        let file = no_follow::open_root(&current)?;
        let stat = file.metadata()?;
        if stat.uid() != 0 || stat.mode() & 0o022 != 0 { return Err(refused()); }
    }
    no_follow::open_root(path)
}

fn owned(path: &Path, limit: u64, deadline: Instant) -> io::Result<(File, Vec<u8>, String)> {
    until(deadline)?;
    let parent = owned_directory(path.parent().ok_or_else(refused)?)?;
    let name = path.file_name().and_then(|value| value.to_str()).ok_or_else(refused)?;
    let mut file = no_follow::open_relative(&parent, &[name])?;
    let stat = file.metadata()?;
    if stat.uid() != 0 || stat.mode() & 0o022 != 0 || stat.len() == 0 || stat.len() > limit { return Err(refused()); }
    let before = no_follow::stamp(&file)?;
    let mut bytes = Vec::with_capacity(stat.len() as usize);
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != stat.len() || no_follow::stamp(&file)? != before ||
        no_follow::stamp(&no_follow::open_relative(&parent, &[name])?)? != before { return Err(refused()); }
    until(deadline)?;
    Ok((file, bytes, before))
}

fn namespace(path: &str, uid: u32, private: bool) -> io::Result<File> {
    let file = no_follow::open_root(Path::new(path))?;
    let stat = file.metadata()?;
    if stat.uid() != uid || private && stat.mode() & 0o077 != 0 { return Err(refused()); }
    Ok(file)
}

impl Profile {
    pub fn enter(project: &str, data: &str) -> io::Result<Self> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let uid = unsafe { libc::getuid() };
        if uid == 0 || uid == u32::MAX || uid != unsafe { libc::geteuid() } ||
            unsafe { libc::getgid() } != unsafe { libc::getegid() } { return Err(refused()); }
        let image = std::env::current_exe()?;
        if fs::canonicalize(&image)? != image { return Err(refused()); }
        let name = image.file_name().and_then(|value| value.to_str()).ok_or_else(refused)?;
        if !matches!(name, "deepagent-work-file-helper" | "deepagent-work-storage-cleanup") { return Err(refused()); }
        let helper = image.parent().ok_or_else(refused)?.join("deepagent-work-file-helper");
        let helper_text = helper.to_str().ok_or_else(refused)?;
        let prefix = helper_text.strip_suffix(SUFFIX).ok_or_else(refused)?;
        let product = prefix.strip_prefix("/opt/").ok_or_else(refused)?;
        if product.is_empty() || product.len() > 80 || !product.as_bytes()[0].is_ascii_alphanumeric() ||
            !product.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'.' | b'_' | b'-')) { return Err(refused()); }
        let (installation_file, installation_bytes, installation_stamp) = owned(
            &Path::new(prefix).join("resources/linux-work-provisioning/write-install.json"), 4096, deadline)?;
        let installation: Installation = serde_json::from_slice(&installation_bytes).map_err(|_| refused())?;
        if installation.domain != "dac.linux-work-write-install.v1" || installation.target != target() ||
            installation.prefix != prefix || installation.helper != helper_text ||
            installation.helper_bytes < 64 || installation.helper_bytes > MAX_BYTES || !digest(&installation.helper_sha256, 64) { return Err(refused()); }
        let (helper_file, helper_bytes, helper_stamp) = owned(&helper, MAX_BYTES, deadline)?;
        if helper_file.metadata()?.mode() & 0o111 == 0 || helper_file.metadata()?.mode() & 0o6000 != 0 { return Err(refused()); }
        if helper_bytes.len() as u64 != installation.helper_bytes || hash(&helper_bytes) != installation.helper_sha256 ||
            helper_bytes.get(..6) != Some(&[0x7f, b'E', b'L', b'F', 2, 1]) ||
            u16::from_le_bytes([helper_bytes[18], helper_bytes[19]]) != if cfg!(target_arch = "x86_64") { 62 } else { 183 } { return Err(refused()); }
        let project_file = namespace(project, uid, false)?;
        let data_file = namespace(data, uid, true)?;
        if project_file.metadata()?.dev() != data_file.metadata()?.dev() || project == data ||
            Path::new(project).starts_with(data) || Path::new(data).starts_with(project) { return Err(refused()); }
        let project_identity = no_follow::identity(&project_file)?;
        let data_identity = no_follow::identity(&data_file)?;
        let directory = PathBuf::from(format!("/var/lib/deepagent-code/work-write-policy/{uid}/{}", &hash(prefix.as_bytes())[..32]));
        let _directory = owned_directory(&directory)?;
        let names = fs::read_dir(&directory)?.map(|entry| entry.map(|value| value.file_name())).collect::<io::Result<Vec<_>>>()?;
        if names.len() > 66 || names.iter().any(|name| name.to_str().is_none_or(|name| {
            if name == "prepare.lock" { return false; }
            let profile = name.strip_suffix(".prepared.json").or_else(|| name.strip_suffix(".json"));
            profile.is_none_or(|value| !value.strip_prefix("dac_write_").is_some_and(|value| digest(value, 48)))
        })) { return Err(refused()); }
        let profiles = names.iter().filter_map(|value| value.to_str()).filter(|value| *value != "prepare.lock")
            .map(|name| name.strip_suffix(".prepared.json").or_else(|| name.strip_suffix(".json")).unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        if profiles.len() > 32 { return Err(refused()); }
        let mut total = 0usize;
        // Inventory includes unfinished preparations; they retain their obligation and
        // cannot make a current helper select an old installation's profile.
        for name in names.iter().filter_map(|value| value.to_str()) {
            let (_, bytes, _) = owned(&directory.join(name), RECORD_BYTES, deadline)?;
            total = total.checked_add(bytes.len()).ok_or_else(refused)?;
            if total > INVENTORY_BYTES { return Err(refused()); }
        }
        let mut selected = None;
        for name in names.iter().filter_map(|value| value.to_str()).filter(|value| value.ends_with(".json") && !value.ends_with(".prepared.json")) {
            until(deadline)?;
            let (ready_file, bytes, ready_stamp) = owned(&directory.join(name), RECORD_BYTES, deadline)?;
            let record: Record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
            if record.domain != "dac.linux-work-write-installation-record.v1" || record.target != target() ||
                record.scope.domain != "dac.linux-work-write-policy.v1" || record.scope.helper != helper_text ||
                record.scope.uid != uid || record.native_authority || !digest(&record.scope.helper_sha256, 64) ||
                format!("{}.json", record.profile) != name || !digest(&record.profile_sha256, 64) { return Err(refused()); }
            if record.scope.project != project || record.scope.data != data ||
                record.scope.helper_sha256 != installation.helper_sha256 { continue; }
            if selected.is_some() || record.project_identity != project_identity || record.data_identity != data_identity { return Err(refused()); }
            let (prepared_file, prepared, prepared_stamp) = owned(&directory.join(format!("{}.prepared.json", record.profile)), RECORD_BYTES, deadline)?;
            if prepared != bytes { return Err(refused()); }
            let (policy_file, policy, policy_stamp) = owned(&Path::new("/etc/apparmor.d").join(&record.profile), RECORD_BYTES, deadline)?;
            if hash(&policy) != record.profile_sha256 { return Err(refused()); }
            selected = Some((record, vec![(ready_file, ready_stamp), (prepared_file, prepared_stamp), (policy_file, policy_stamp)]));
        }
        let (record, mut retained) = selected.ok_or_else(refused)?;
        retained.push((installation_file, installation_stamp));
        retained.push((helper_file, helper_stamp));
        if image != helper {
            let (file, _, stamp) = owned(&image, MAX_BYTES, deadline)?;
            retained.push((file, stamp));
        }
        let mut attr = File::options().write(true).open("/proc/self/attr/apparmor/current")?;
        attr.write_all(format!("changeprofile {}\0", record.profile).as_bytes())?;
        drop(attr);
        let value = Self { uid, description: Description { profile: record.profile, profile_sha256: record.profile_sha256,
            helper_sha256: installation.helper_sha256, project_identity, data_identity, enforced: true },
            project: project.into(), data: data.into(), project_file, data_file, retained };
        value.current()?;
        Ok(value)
    }

    pub fn current(&self) -> io::Result<()> {
        if unsafe { libc::getuid() } != self.uid || unsafe { libc::geteuid() } != self.uid ||
            unsafe { libc::getgid() } != unsafe { libc::getegid() } ||
            self.project_file.metadata()?.uid() != self.uid || self.data_file.metadata()?.uid() != self.uid ||
            self.data_file.metadata()?.mode() & 0o077 != 0 { return Err(refused()); }
        let mut bytes = Vec::new();
        File::open("/proc/self/attr/apparmor/current")?.take(1025).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 || String::from_utf8(bytes).map_err(|_| refused())?.trim_end_matches(['\n', '\0']) !=
            format!("{} (enforce)", self.description.profile) { return Err(refused()); }
        if no_follow::identity(&self.project_file)? != self.description.project_identity ||
            no_follow::identity(&no_follow::open_root(&self.project)?)? != self.description.project_identity ||
            no_follow::identity(&self.data_file)? != self.description.data_identity ||
            no_follow::identity(&no_follow::open_root(&self.data)?)? != self.description.data_identity ||
            self.retained.iter().any(|(file, stamp)| no_follow::stamp(file).ok().as_ref() != Some(stamp)) { return Err(refused()); }
        Ok(())
    }
}
