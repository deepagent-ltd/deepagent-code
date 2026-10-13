#![cfg(unix)]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, os::unix::fs::{MetadataExt, PermissionsExt, symlink}, path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio}, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { base: PathBuf, root: PathBuf, workspace: PathBuf, child: Child, input: ChildStdin, output: ChildStdout }
fn identity(path: &std::path::Path) -> Value {
    let stat = fs::metadata(path).unwrap(); json!({"kind":"posix","device":stat.dev().to_string(),"inode":stat.ino().to_string()})
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("dac-command-snapshot-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&base).unwrap(); let base = fs::canonicalize(base).unwrap();
        let root = base.join("root"); let workspace = base.join("workspace");
        fs::create_dir(&root).unwrap(); fs::create_dir(&workspace).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_deepagent-work-file-helper"))
            .env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let input = child.stdin.take().unwrap(); let output = child.stdout.take().unwrap();
        let mut f = Self { base, root, workspace, child, input, output };
        assert_eq!(f.request(json!({"op":"open_root","version":1,"id":"root","path":f.root,"expected":identity(&f.root)}))["status"], "ready");
        f
    }
    fn request(&mut self, value: Value) -> Value {
        let body = serde_json::to_vec(&value).unwrap();
        self.input.write_all(&(body.len() as u32).to_be_bytes()).unwrap(); self.input.write_all(&body).unwrap(); self.input.flush().unwrap();
        let mut size = [0;4]; self.output.read_exact(&mut size).unwrap();
        let size = u32::from_be_bytes(size) as usize; assert!(size <= 65_536);
        let mut body = vec![0; size]; self.output.read_exact(&mut body).unwrap(); serde_json::from_slice(&body).unwrap()
    }
    fn input(&self, relative: &str, content: &[u8]) -> Value {
        let target = self.root.join(relative); fs::create_dir_all(target.parent().unwrap()).unwrap(); fs::write(&target, content).unwrap();
        json!({"relative":relative,"identity":identity(&target),"sha256":format!("{:x}",Sha256::digest(content)),"bytes":content.len()})
    }
    fn snapshot(&mut self, inputs: Vec<Value>, outputs: Vec<&str>) -> Value {
        self.request(json!({"op":"snapshot_workspace","version":1,"id":"copy","workspace":self.workspace,
            "workspace_identity":identity(&self.workspace),"inputs":inputs,"outputs":outputs,"deadline_ms":10000}))
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = fs::remove_dir_all(&self.base); } }

#[test]
fn snapshot_copies_exact_bytes_and_precreates_only_explicit_outputs() {
    let mut f = Fixture::new(); let input = f.input("src/中文.ts", "export const 测试 = 42;\n".as_bytes());
    let output = f.snapshot(vec![input.clone()], vec!["dist/output.js"]);
    assert_eq!(output["status"], "snapshot_ready"); assert_eq!(output["snapshot"]["files"], 1);
    assert_eq!(output["snapshot"]["bytes"], input["bytes"]);
    assert_eq!(fs::read(f.workspace.join("src/中文.ts")).unwrap(), fs::read(f.root.join("src/中文.ts")).unwrap());
    assert_eq!(fs::metadata(f.workspace.join("dist/output.js")).unwrap().len(), 0);
    assert_eq!(f.snapshot(vec![input], vec![])["status"], "refused");
}

#[test]
fn changed_version_symlink_and_same_root_never_produce_a_ready_snapshot() {
    for case in ["version", "symlink", "root"] {
        let mut f = Fixture::new(); let input = f.input("input.ts", b"original");
        match case {
            "version" => fs::write(f.root.join("input.ts"), b"changed!").unwrap(),
            "symlink" => { fs::rename(f.root.join("input.ts"), f.base.join("outside")).unwrap(); symlink(f.base.join("outside"), f.root.join("input.ts")).unwrap(); },
            "root" => f.workspace = f.root.clone(),
            _ => unreachable!(),
        }
        assert_eq!(f.snapshot(vec![input], vec![])["status"], "refused");
    }
}

#[test]
fn bounds_and_private_mode_refuse_before_copying_file_bytes() {
    for case in ["files", "file_bytes", "depth", "duplicate", "outputs", "mode"] {
        let mut f = Fixture::new(); let input = f.input("input.ts", b"content");
        let mut inputs = vec![input]; let mut outputs = vec![];
        match case {
            "files" => inputs = vec![inputs[0].clone(); 257],
            "file_bytes" => inputs[0]["bytes"] = json!(16_777_217),
            "depth" => inputs[0]["relative"] = json!(vec!["nested";17].join("/")),
            "duplicate" => outputs = vec!["input.ts"],
            "outputs" => outputs = vec!["output";33],
            "mode" => fs::set_permissions(&f.workspace, fs::Permissions::from_mode(0o755)).unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(f.snapshot(inputs, outputs)["status"], "refused", "{case}");
        assert_eq!(fs::read_dir(&f.workspace).unwrap().count(), 0, "{case}");
    }
}
