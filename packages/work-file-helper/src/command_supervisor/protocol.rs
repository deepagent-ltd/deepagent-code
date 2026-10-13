//! Private signed-supervisor protocol. These descriptors never grant Work authority.
//! The owning Host must authorize the original Ready before sending Continue.
use crate::protocol::Identity;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::{self, Read, Write}};

pub const FRAME_BYTES: usize = 65_536;
pub const DATA_BYTES: usize = 8192;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub path: String,
    pub mount_path: Option<String>,
    pub identity: Identity,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input { pub relative: String, pub identity: Identity, pub sha256: String, pub bytes: u64 }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxCpu {
    pub quota_micros: u64,
    pub period_micros: u64,
    pub total_watchdog_micros: u64,
    pub poll_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsCpu {
    pub hard_cap_percent: u32,
    pub job_user_time_limit_100ns: u64,
    pub total_watchdog_micros: u64,
    pub poll_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "id", deny_unknown_fields)]
pub enum Isolation {
    #[serde(rename = "linux-cgroup2-single-payload-v1")]
    Linux { cpu: LinuxCpu, memory_max_bytes: u64, memory_swap_max_bytes: u64, tasks_max: u32,
        // Private factory configuration; this path is never accepted from an HTTP Recipe.
        delegated_cgroup: String, runtime_files: Vec<Image> },
    #[serde(rename = "win32-job-appcontainer-single-payload-v1")]
    Windows { cpu: WindowsCpu, job_commit_max_bytes: u64, job_processes_max: u32, runtime_files: Vec<Image> },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub version: u8,
    pub nonce: String,
    pub work_id: String,
    pub command_id: String,
    pub recipe_hash: String,
    pub control_revision: u64,
    pub workspace: String,
    pub workspace_identity: Identity,
    pub executable: Image,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub inputs: Vec<Input>,
    pub outputs: Vec<String>,
    pub isolation: Isolation,
    pub timeout_ms: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Control {
    Continue { version: u8, nonce: String },
    Cancel { version: u8, nonce: String },
}

#[derive(Serialize)]
pub struct StreamSummary { pub sha256: String, pub captured_sha256: String, pub bytes: u64, pub captured_bytes: u64, pub eof: bool }
#[derive(Serialize)]
pub struct Watchdog { pub poll_ms: u64, pub cpu_micros: u64, pub observed_threads_max: Option<u32>,
    pub observed_output_bytes_max: Option<u64>, pub triggered: Vec<&'static str> }

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event<'a> {
    Ready { version: u8, nonce: &'a str, work_id: &'a str, command_id: &'a str,
        recipe_hash: &'a str, control_revision: u64, root_pid: u32, containment: &'a str },
    Data { version: u8, nonce: &'a str, stream: &'a str, hex: &'a str },
    Stopped { version: u8, nonce: &'a str, root_exit: bool, tree_empty: bool, stdout: StreamSummary,
        stderr: StreamSummary, cancelled: bool, exit_code: Option<i32>, signal: Option<i32>, elapsed_ms: u64, watchdog: Watchdog },
    Unavailable { version: u8, nonce: &'a str, code: &'a str },
}

pub fn read<A: for<'de> Deserialize<'de>>(input: &mut impl Read) -> io::Result<A> {
    let mut size = [0; 4];
    input.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > FRAME_BYTES { return Err(io::ErrorKind::InvalidData.into()); }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData.into())
}

pub fn write(output: &mut impl Write, event: &Event<'_>) -> io::Result<()> {
    let bytes = serde_json::to_vec(event).map_err(|_| io::ErrorKind::InvalidData)?;
    if bytes.is_empty() || bytes.len() > FRAME_BYTES { return Err(io::ErrorKind::InvalidData.into()); }
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

pub fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn id(value: &str) -> bool { !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control) }
fn path(value: &str) -> bool { !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control) &&
    std::path::Path::new(value).is_absolute() }
fn image(value: &Image) -> bool { path(&value.path) &&
    digest(&value.sha256) && (1..=268_435_456).contains(&value.bytes) }
fn memory(value: u64) -> bool { (16_777_216..=2_147_483_648).contains(&value) }
fn cpu(total: u64, poll: u64) -> bool { (1..=600_000_000).contains(&total) && (10..=100).contains(&poll) }

impl Run {
    pub fn validate(&self) -> io::Result<()> {
        let paths = self.outputs.iter().collect::<std::collections::BTreeSet<_>>();
        let inputs = self.inputs.iter().map(|input| &input.relative).collect::<std::collections::BTreeSet<_>>();
        let valid = self.version == 2 && digest(&self.nonce) && id(&self.work_id) && id(&self.command_id) &&
            digest(&self.recipe_hash) && self.control_revision > 0 && path(&self.workspace) && image(&self.executable) && self.executable.mount_path.is_none() &&
            (1..=600_000).contains(&self.timeout_ms) && (1..=1_048_576).contains(&self.stdout_bytes) &&
            (1..=1_048_576).contains(&self.stderr_bytes) && self.argv.len() <= 64 &&
            self.argv.iter().all(|arg| arg.len() <= 2048 && !arg.contains('\0')) &&
            self.argv.iter().map(String::len).sum::<usize>() <= 16_384 && self.env.len() <= 7 &&
            self.env.iter().all(|(name, value)| ["CI", "LANG", "LC_ALL", "TZ", "NO_COLOR", "FORCE_COLOR", "SOURCE_DATE_EPOCH"].contains(&name.as_str()) &&
                value.len() <= 128 && !value.chars().any(char::is_control)) && self.outputs.len() <= 32 &&
            paths.len() == self.outputs.len() && self.outputs.iter().all(|path| relative(path)) &&
            self.inputs.len() <= 256 && inputs.len() == self.inputs.len() && inputs.is_disjoint(&paths) &&
            self.inputs.iter().all(|input| relative(&input.relative) && digest(&input.sha256) && input.bytes <= 16_777_216) &&
            self.inputs.iter().map(|input| input.bytes).sum::<u64>() <= 67_108_864 &&
            self.cwd.as_ref().is_none_or(|path| relative(path));
        if !valid { return Err(io::ErrorKind::InvalidInput.into()); }
        match &self.isolation {
            Isolation::Linux { cpu: limit, memory_max_bytes, memory_swap_max_bytes, tasks_max, delegated_cgroup, runtime_files } => {
                if !cpu(limit.total_watchdog_micros, limit.poll_ms) || !(1000..=1_000_000).contains(&limit.quota_micros) ||
                    !(1000..=1_000_000).contains(&limit.period_micros) || !memory(*memory_max_bytes) || *memory_swap_max_bytes != 0 ||
                    *tasks_max != 66 || !path(delegated_cgroup) || runtime_files.len() > 128 ||
                    runtime_files.iter().any(|file| !image(file) || file.path == self.executable.path ||
                        file.mount_path.as_ref().is_none_or(|value| !path(value) ||
                            !["/lib/", "/lib64/", "/usr/lib/", "/usr/lib64/"].iter().any(|prefix| value.starts_with(prefix)))) ||
                    runtime_files.iter().map(|file| &file.path).collect::<std::collections::BTreeSet<_>>().len() != runtime_files.len() {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
            }
            Isolation::Windows { cpu: limit, job_commit_max_bytes, job_processes_max, runtime_files } => {
                if !cpu(limit.total_watchdog_micros, limit.poll_ms) || !(1..=100).contains(&limit.hard_cap_percent) ||
                    !(1..=6_000_000_000).contains(&limit.job_user_time_limit_100ns) || !memory(*job_commit_max_bytes) || *job_processes_max != 1 ||
                    runtime_files.len() > 128 || runtime_files.iter().any(|file| !image(file) || file.mount_path.is_some()) {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
            }
        }
        Ok(())
    }
}

fn relative(path: &str) -> bool { crate::no_follow::relative(path).is_ok_and(|parts|
    parts.len() <= 16 && !parts.iter().any(|part| part.starts_with(".dac-"))) }

impl Control {
    pub fn matches(&self, nonce: &str) -> bool {
        match self { Self::Continue { version, nonce: actual } | Self::Cancel { version, nonce: actual } => *version == 2 && actual == nonce }
    }
}

#[cfg(test)]
mod tests {
    use super::{Control, read};
    #[test]
    fn oversized_and_excess_control_are_refused() {
        assert!(read::<Control>(&mut &(65_537u32.to_be_bytes())[..]).is_err());
        let bytes = br#"{"action":"continue","version":2,"nonce":"original","actor":true}"#;
        let frame = [&(bytes.len() as u32).to_be_bytes()[..], bytes].concat();
        assert!(read::<Control>(&mut &frame[..]).is_err());
    }
    #[test]
    fn continuation_is_bound_to_original_nonce_and_version() {
        assert!(Control::Continue { version: 2, nonce: "original".into() }.matches("original"));
        assert!(!Control::Continue { version: 1, nonce: "original".into() }.matches("original"));
        assert!(!Control::Continue { version: 2, nonce: "copied".into() }.matches("original"));
    }
}
