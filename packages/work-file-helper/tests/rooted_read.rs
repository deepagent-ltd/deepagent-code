#![cfg(unix)]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, os::unix::fs::{MetadataExt, PermissionsExt, symlink}, path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio}, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{SystemTime, UNIX_EPOCH}};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { directory: PathBuf, child: Child, input: ChildStdin, output: ChildStdout }
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("dac-native-file-{}-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&directory).unwrap();
        let directory = fs::canonicalize(directory).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_deepagent-work-file-helper"))
            .env_clear().env("HOME", &directory).env("TMPDIR", &directory)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        Self { directory, child, input, output }
    }
    fn request(&mut self, value: Value) -> (Value, Vec<u8>) {
        let body = serde_json::to_vec(&value).unwrap();
        self.input.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        self.input.write_all(&body).unwrap();
        self.input.flush().unwrap();
        let mut length = [0; 4]; self.output.read_exact(&mut length).unwrap();
        let length = u32::from_be_bytes(length) as usize;
        assert!(length <= 65_536);
        let mut body = vec![0; length]; self.output.read_exact(&mut body).unwrap();
        let response: Value = serde_json::from_slice(&body).unwrap();
        let count = response["payload_bytes"].as_u64().unwrap() as usize;
        assert!(count <= 51_200);
        let mut payload = vec![0; count]; self.output.read_exact(&mut payload).unwrap();
        (response, payload)
    }
    fn open(&mut self) {
        let stat = fs::metadata(&self.directory).unwrap();
        let (response, _) = self.request(json!({"op":"open_root","version":1,"id":"root","path":self.directory,
            "expected":{"kind":"posix","device":stat.dev().to_string(),"inode":stat.ino().to_string()}}));
        assert_eq!(response["status"], "ready");
    }
    fn read(&mut self, relative: &str, offset: u64, length: u64) -> (Value, Vec<u8>) {
        self.request(json!({"op":"read","version":1,"id":"read","relative":relative,
            "offset":offset,"length":length,"scan_limit":16_777_216,"deadline_ms":10_000}))
    }
    fn observe(&mut self, relative: &str) -> (Value, Vec<u8>) {
        self.request(json!({"op":"observe","version":1,"id":"observe","relative":relative,
            "scan_limit":16_777_216,"deadline_ms":10_000}))
    }
}

#[test]
fn observe_hashes_binary_and_empty_files_without_returning_content() {
    let mut f = Fixture::new();
    let bytes: Vec<u8> = (0..=255).cycle().take(100_003).collect();
    fs::write(f.directory.join("binary"), &bytes).unwrap();
    fs::write(f.directory.join("empty"), []).unwrap();
    f.open();
    assert_eq!(f.read("binary", 0, 256).0["status"], "refused");
    for (name, content) in [("binary", bytes.as_slice()), ("empty", &[][..])] {
        let (response, payload) = f.observe(name);
        assert_eq!(response["status"], "observed");
        assert_eq!(response["observation"]["observed_sha256"], format!("{:x}", Sha256::digest(content)));
        assert_eq!(response["observation"]["file_bytes"], content.len());
        assert_eq!(response["observation"]["scanned_bytes"], content.len());
        assert_eq!(response["observation"]["page_sha256"], format!("{:x}", Sha256::digest([])));
        assert!(payload.is_empty());
    }
    assert_eq!(f.read("empty", 0, 0).0["status"], "refused");
}

#[test]
fn observe_distinguishes_missing_from_permission_and_scope_failures() {
    assert_ne!(unsafe { libc::geteuid() }, 0, "permission oracle requires an unprivileged process");
    let mut f = Fixture::new();
    fs::write(f.directory.join("denied"), b"private").unwrap();
    fs::set_permissions(f.directory.join("denied"), fs::Permissions::from_mode(0)).unwrap();
    symlink("absent", f.directory.join("alias")).unwrap();
    f.open();
    let missing = f.observe("absent");
    assert_eq!(missing.0["status"], "missing");
    assert!(missing.0["observation"].is_null() && missing.1.is_empty());
    for name in ["denied", "alias", "../absent"] {
        assert_eq!(f.observe(name).0["status"], "refused", "{name}");
    }
    fs::set_permissions(f.directory.join("denied"), fs::Permissions::from_mode(0o600)).unwrap();
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill(); let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn actual_native_read_binds_full_stream_and_explicit_page() {
    let mut f = Fixture::new();
    let bytes = "受管文本\n".repeat(12_000).into_bytes();
    fs::create_dir(f.directory.join("src")).unwrap();
    fs::write(f.directory.join("src/中文.txt"), &bytes).unwrap();
    f.open();
    let (response, first) = f.read("src/中文.txt", 0, 51_200);
    assert_eq!(response["status"], "observed");
    assert!(first.len() <= 51_200 && first.len() >= 51_197);
    assert!(std::str::from_utf8(&first).is_ok());
    assert_eq!(first, bytes[..first.len()]);
    assert_eq!(response["observation"]["observed_sha256"], format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(response["observation"]["page_sha256"], format!("{:x}", Sha256::digest(&first)));
    assert_eq!(response["observation"]["snapshot"], "stream_observation");
    assert_eq!(response["observation"]["scanned_bytes"], bytes.len());
    let (_, second) = f.read("src/中文.txt", first.len() as u64, 51_200);
    assert!(std::str::from_utf8(&second).is_ok());
    assert_eq!(second, bytes[first.len()..first.len() + second.len()]);
    assert_eq!(f.read("src/中文.txt", 1, 51_200).0["status"], "refused");
    assert_eq!(f.read("src/中文.txt", bytes.len() as u64, 10).1.len(), 0);
    let (closed, _) = f.request(json!({"op":"close","version":1,"id":"close"}));
    assert_eq!(closed["status"], "closed");
    assert!(f.child.wait().unwrap().success());
}

#[test]
fn native_refuses_symlink_ancestors_leaf_hardlink_fifo_and_escaped_names() {
    let mut f = Fixture::new();
    fs::create_dir(f.directory.join("inside")).unwrap();
    fs::write(f.directory.join("inside/a"), b"secret").unwrap();
    symlink("inside", f.directory.join("alias")).unwrap();
    symlink("inside/a", f.directory.join("leaf")).unwrap();
    fs::hard_link(f.directory.join("inside/a"), f.directory.join("hard")).unwrap();
    let fifo = std::ffi::CString::new(f.directory.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    f.open();
    for name in ["alias/a", "leaf", "hard", "inside/a", "fifo", ".", "..", "../secret", "/etc/passwd", "inside//a", "inside/../inside/a", "inside\\a", "a:stream", "a\n"] {
        let (response, bytes) = f.read(name, 0, 10);
        assert_eq!(response["status"], "refused", "{name:?}");
        assert!(bytes.is_empty());
        assert_eq!(f.observe(name).0["status"], "refused", "{name:?}");
    }
}

#[test]
fn original_root_cannot_be_replaced_or_rebound_in_live_process() {
    let mut f = Fixture::new();
    fs::write(f.directory.join("a"), b"original").unwrap();
    f.open();
    let moved = f.directory.with_extension("moved");
    fs::rename(&f.directory, &moved).unwrap();
    fs::create_dir(&f.directory).unwrap();
    fs::write(f.directory.join("a"), b"replacement").unwrap();
    assert_eq!(f.read("a", 0, 100).0["status"], "refused");
    assert_eq!(f.observe("a").0["status"], "refused");
    assert_eq!(f.observe("absent").0["status"], "refused");
    let stat = fs::metadata(&f.directory).unwrap();
    let (response, _) = f.request(json!({"op":"open_root","version":1,"id":"replace","path":f.directory,
        "expected":{"kind":"posix","device":stat.dev().to_string(),"inode":stat.ino().to_string()}}));
    assert_eq!(response["status"], "refused");
    fs::remove_dir_all(moved).unwrap();
}

#[test]
fn concurrent_symlink_swaps_never_read_external_target() {
    let mut f = Fixture::new();
    fs::create_dir(f.directory.join("root")).unwrap();
    fs::write(f.directory.join("outside"), b"OUTSIDE_SECRET").unwrap();
    fs::write(f.directory.join("root/a"), b"allowed").unwrap();
    let outer = f.directory.clone();
    f.directory = f.directory.join("root");
    f.open();
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = stop.clone();
    let root = f.directory.clone();
    let writer = std::thread::spawn(move || {
        while !writer_stop.load(Ordering::Relaxed) {
            let _ = fs::remove_file(root.join("next"));
            symlink("../outside", root.join("next")).unwrap();
            fs::rename(root.join("next"), root.join("a")).unwrap();
            fs::write(root.join("next"), b"allowed").unwrap();
            fs::rename(root.join("next"), root.join("a")).unwrap();
        }
    });
    for _ in 0..128 {
        let (response, bytes) = f.read("a", 0, 100);
        assert!(response["status"] == "refused" || response["status"] == "observed");
        assert!(bytes.is_empty() || bytes == b"allowed");
    }
    stop.store(true, Ordering::Relaxed); writer.join().unwrap();
    drop(f); fs::remove_dir_all(outer).unwrap();
}

#[test]
fn budgets_and_invalid_frame_fail_before_unbounded_allocation() {
    let mut f = Fixture::new();
    fs::write(f.directory.join("a"), b"value").unwrap();
    assert_eq!(f.read("a", 0, 10).0["status"], "refused");
    f.open();
    for (offset, length) in [(0, 51_201), (0, 0), (6, 1), (u64::MAX, 2)] {
        assert_eq!(f.read("a", offset, length).0["status"], "refused");
    }
    let (response, _) = f.request(json!({"op":"read","version":1,"id":"limited","relative":"a",
        "offset":0,"length":1,"scan_limit":4,"deadline_ms":10_000}));
    assert_eq!(response["status"], "refused");
    for (limit, deadline) in [(4, 10_000), (0, 10_000), (16_777_217, 10_000), (10, 0), (10, 30_001)] {
        assert_eq!(f.request(json!({"op":"observe","version":1,"id":"limited","relative":"a",
            "scan_limit":limit,"deadline_ms":deadline})).0["status"], "refused");
    }
    f.input.write_all(&u32::MAX.to_be_bytes()).unwrap(); f.input.flush().unwrap();
    assert_eq!(f.child.wait().unwrap().code(), Some(2));
    assert_eq!(f.output.read(&mut [0; 1]).unwrap(), 0);
}

#[test]
fn metadata_inspection_exits_without_leaving_a_read_capability() {
    let mut f = Fixture::new();
    let stat = fs::metadata(&f.directory).unwrap();
    let (reply, bytes) = f.request(json!({"op":"inspect_root","version":1,"id":"inspect","path":f.directory}));
    assert_eq!(reply["status"], "ready");
    assert_eq!(reply["root"]["device"], stat.dev().to_string());
    assert_eq!(reply["root"]["inode"], stat.ino().to_string());
    assert!(bytes.is_empty());
    assert!(f.child.wait().unwrap().success());
}
