#![cfg(target_vendor = "apple")]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, os::unix::fs::{MetadataExt, PermissionsExt}, path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio}, time::{SystemTime, UNIX_EPOCH}};

struct Fixture { base: PathBuf, child: Child, input: ChildStdin, output: ChildStdout }
fn identity(path: &std::path::Path) -> Value {
    let stat = fs::metadata(path).unwrap();
    json!({"kind":"posix","device":stat.dev().to_string(),"inode":stat.ino().to_string()})
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("dac-native-write-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(base.join("root/sub")).unwrap();
        fs::create_dir(base.join("stage")).unwrap();
        fs::set_permissions(base.join("stage"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(base.join("outside")).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let binary = fs::canonicalize(env!("CARGO_BIN_EXE_deepagent-work-file-helper")).unwrap();
        let quote = |value: &std::path::Path| serde_json::to_string(value.to_str().unwrap()).unwrap();
        let policy = format!("(version 1)(deny default)(allow process-exec (literal {}))\
            (allow file-read-metadata)(allow file-read* (literal \"/\") (literal {})\
            (subpath \"/System/Library\") (subpath \"/usr/lib\") (subpath {}) (subpath {}))\
            (allow file-map-executable (literal {}) (subpath \"/System/Library\") (subpath \"/usr/lib\"))\
            (allow sysctl-read)(allow signal (target self))(allow file-write* (subpath {}) (subpath {}))\
            (deny system-fcntl (fcntl-command 80 110))",
            quote(&binary), quote(&binary), quote(&base.join("root")), quote(&base.join("stage")),
            quote(&binary), quote(&base.join("root")), quote(&base.join("stage")));
        let mut child = Command::new("/usr/bin/sandbox-exec").args(["-p", &policy, "--"])
            .arg(binary).env_clear().current_dir("/")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let input = child.stdin.take().unwrap(); let output = child.stdout.take().unwrap();
        let mut value = Self { base, child, input, output };
        assert_eq!(value.request(json!({"version":1,"op":"open_root","id":"root",
            "path":value.base.join("root"),"expected":identity(&value.base.join("root"))}))["status"], "ready");
        value
    }
    fn request(&mut self, value: Value) -> Value {
        let bytes = serde_json::to_vec(&value).unwrap();
        self.input.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap(); self.input.write_all(&bytes).unwrap(); self.input.flush().unwrap();
        let mut length = [0;4]; self.output.read_exact(&mut length).unwrap();
        let length = u32::from_be_bytes(length) as usize; assert!(length <= 65_536);
        let mut bytes = vec![0;length]; self.output.read_exact(&mut bytes).unwrap();
        let response: Value = serde_json::from_slice(&bytes).unwrap(); assert_eq!(response["payload_bytes"],0); response
    }
    fn prepare(&mut self, expected: Value) -> Value {
        self.request(json!({"version":1,"op":"prepare_write","id":"write1","relative":"sub/target",
            "stage":self.base.join("stage"),"stage_identity":identity(&self.base.join("stage")),
            "content":"原子写入\n","expected":expected,"deadline_ms":10_000}))
    }
    fn publish(&mut self) -> Value { self.request(json!({"version":1,"op":"publish_write","id":"publish1","prepared_id":"write1"})) }
    fn expected(&self) -> Value {
        let path = self.base.join("root/sub/target"); let bytes = fs::read(&path).unwrap();
        json!({"kind":"observed","identity":identity(&path),"sha256":format!("{:x}",Sha256::digest(&bytes)),"bytes":bytes.len()})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = fs::remove_dir_all(&self.base); }
}

#[test]
fn actual_sandbox_create_and_exchange_preserve_complete_payload_and_original_object() {
    for exists in [false,true] {
        let mut f = Fixture::new();
        if exists { fs::write(f.base.join("root/sub/target"), b"original").unwrap(); }
        let expected = if exists { f.expected() } else { json!({"kind":"missing"}) };
        assert_eq!(f.prepare(expected)["status"], "prepared");
        assert_eq!(fs::read(f.base.join("stage/payload")).unwrap(), "原子写入\n".as_bytes());
        let result = f.publish(); assert_eq!(result["status"],"published", "{result}");
        assert_eq!(result["write"]["publication"], "optimistic_namespace_publish");
        assert_eq!(fs::read(f.base.join("root/sub/target")).unwrap(), "原子写入\n".as_bytes());
        if exists { assert_eq!(fs::read(f.base.join("stage/payload")).unwrap(), b"original"); }
        assert_eq!(f.publish()["status"], "refused");
        assert_eq!(f.prepare(json!({"kind":"missing"}))["status"], "refused");
    }
}

#[test]
fn current_content_version_change_is_refused_before_publication() {
    let mut f=Fixture::new();fs::write(f.base.join("root/sub/target"),b"original").unwrap();
    let expected=f.expected();assert_eq!(f.prepare(expected)["status"],"prepared");
    fs::write(f.base.join("root/sub/target"),b"user-edited").unwrap();
    assert_eq!(f.publish()["status"],"refused");
    assert_eq!(fs::read(f.base.join("root/sub/target")).unwrap(),b"user-edited");
    assert_eq!(fs::read(f.base.join("stage/payload")).unwrap(),"原子写入\n".as_bytes());
}

#[test]
fn external_parent_move_cannot_publish_into_the_now_unapproved_tree() {
    let mut f=Fixture::new();fs::write(f.base.join("root/sub/target"),b"original").unwrap();
    let expected=f.expected();assert_eq!(f.prepare(expected)["status"],"prepared");
    fs::rename(f.base.join("root/sub"),f.base.join("outside/moved")).unwrap();
    let result=f.publish();assert!(result["status"]=="refused"||result["status"]=="unknown");
    assert_eq!(fs::read(f.base.join("outside/moved/target")).unwrap(),b"original");
    assert_eq!(fs::read(f.base.join("stage/payload")).unwrap(),"原子写入\n".as_bytes());
}

#[test]
fn scope_close_after_prepare_never_publishes_or_replays() {
    let mut f=Fixture::new();assert_eq!(f.prepare(json!({"kind":"missing"}))["status"],"prepared");
    f.child.kill().unwrap();f.child.wait().unwrap();
    assert!(!f.base.join("root/sub/target").exists());
    assert_eq!(fs::read(f.base.join("stage/payload")).unwrap(),"原子写入\n".as_bytes());
}

#[test]
fn stage_permission_change_after_prepare_is_refused_without_publication() {
    let mut f=Fixture::new();assert_eq!(f.prepare(json!({"kind":"missing"}))["status"],"prepared");
    fs::set_permissions(f.base.join("stage"),fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(f.publish()["status"],"refused");
    assert!(!f.base.join("root/sub/target").exists());
}

#[test]
fn cleanup_requires_this_live_known_result_and_never_republishes() {
    for refused in [false, true] {
        let mut f = Fixture::new();
        fs::write(f.base.join("root/sub/target"), b"original").unwrap();
        let expected = f.expected();
        assert_eq!(f.prepare(expected)["status"], "prepared");
        // Preparation is not a known outcome and cannot release payload custody.
        assert_eq!(f.request(json!({"version":1,"op":"cleanup_write","id":"early"}))["status"], "refused");
        assert!(f.base.join("stage/payload").exists());
        if refused { fs::write(f.base.join("root/sub/target"), b"new-user-version").unwrap(); }
        assert_eq!(f.publish()["status"], if refused { "refused" } else { "published" });
        let target = fs::read(f.base.join("root/sub/target")).unwrap();
        assert_eq!(f.request(json!({"version":1,"op":"cleanup_write","id":"cleanup"}))["status"], "cleaned");
        assert!(fs::read_dir(f.base.join("stage")).unwrap().next().is_none());
        assert_eq!(fs::read(f.base.join("root/sub/target")).unwrap(), target);
        assert_eq!(f.request(json!({"version":1,"op":"cleanup_write","id":"replay"}))["status"], "refused");
        assert_eq!(f.publish()["status"], "refused");
    }
}

#[test]
fn cleanup_rejects_rebound_stage_and_does_not_delete_a_foreign_object() {
    let mut f = Fixture::new();
    assert_eq!(f.prepare(json!({"kind":"missing"}))["status"], "prepared");
    assert_eq!(f.publish()["status"], "published");
    fs::rename(f.base.join("stage"), f.base.join("outside/retained")).unwrap();
    fs::create_dir(f.base.join("stage")).unwrap();
    fs::set_permissions(f.base.join("stage"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(f.base.join("stage/payload"), b"foreign").unwrap();
    assert_eq!(f.request(json!({"version":1,"op":"cleanup_write","id":"changed"}))["status"], "refused");
    assert_eq!(fs::read(f.base.join("stage/payload")).unwrap(), b"foreign");
}
