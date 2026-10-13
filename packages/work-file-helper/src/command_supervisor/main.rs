//! Separate v2 supervisor. The v1 helper and macOS command entry are unchanged.
#[path = "../protocol.rs"]
mod protocol;
#[path = "../root.rs"]
mod root;
#[path = "../snapshot.rs"]
mod snapshot;
#[path = "../no_follow/mod.rs"]
mod no_follow;
#[cfg(windows)]
#[path = "../regular_file.rs"]
mod regular_file;
#[cfg(windows)]
#[path = "../native_windows/mod.rs"]
mod native_windows;
#[cfg(windows)]
#[path = "../snapshot_windows.rs"]
mod snapshot_windows;
#[path = "mod.rs"]
mod command_supervisor;

fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() == ["--probe-linux-namespaces"] {
        let result = command_supervisor::probe_linux_namespaces();
        println!("{{\"version\":1,\"namespace_setup\":{},\"payloads\":0,\"native_authority\":false}}", result.is_ok());
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if std::env::args().len() != 1 { std::process::exit(2); }
    let request = command_supervisor::protocol::read::<command_supervisor::protocol::Run>(&mut std::io::stdin().lock());
    let Ok(request) = request else { std::process::exit(2); };
    if request.validate().is_err() { std::process::exit(2); }
    let nonce = request.nonce.clone();
    let result = command_supervisor::run(request);
    if result.is_err() {
        let _ = command_supervisor::protocol::write(&mut std::io::stdout().lock(), &command_supervisor::protocol::Event::Unavailable {
            version: 2, nonce: &nonce, code: "SUPERVISOR_UNAVAILABLE" });
        std::process::exit(1);
    }
}
