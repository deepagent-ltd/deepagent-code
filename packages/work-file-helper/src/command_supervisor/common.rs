use super::protocol::{DATA_BYTES, Event, Run, StreamSummary};
use crate::{no_follow, root::Root};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read}, path::Path, sync::{Arc, Mutex}, thread, time::Instant};

pub struct Prepared {
    pub root: Root,
    pub executable: File,
    pub cwd: File,
}

pub fn prepare(run: &Run) -> io::Result<Prepared> {
    run.validate()?;
    let root = Root::open(&run.workspace, run.workspace_identity.clone())?;
    let cwd_path = run.cwd.as_ref().map_or(root.path.clone(), |relative| root.path.join(relative));
    let cwd = no_follow::open_root(&cwd_path)?;
    let executable = image(&run.executable)?;
    root.current()?;
    Ok(Prepared { root, executable, cwd })
}

pub fn image(image: &super::protocol::Image) -> io::Result<File> {
    let path = Path::new(&image.path);
    #[cfg(unix)]
    if std::fs::canonicalize(path)? != path { return Err(io::ErrorKind::PermissionDenied.into()); }
    let parts = path.file_name().and_then(|part| part.to_str()).ok_or(io::ErrorKind::InvalidInput)?;
    let parent = no_follow::open_root(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    let mut file = no_follow::open_relative(&parent, &[parts])?;
    let stamp = no_follow::stamp(&file)?;
    if no_follow::identity(&file)? != image.identity || file.metadata()?.len() != image.bytes {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut digest = Sha256::new();
    if io::copy(&mut Read::by_ref(&mut file).take(image.bytes + 1), &mut digest)? != image.bytes ||
        format!("{:x}", digest.finalize()) != image.sha256 || no_follow::stamp(&file)? != stamp ||
        no_follow::stamp(&no_follow::open_relative(&parent, &[parts])?)? != stamp {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

pub type Output = Arc<Mutex<io::Stdout>>;
pub fn emit(output: &Output, event: &Event<'_>) -> io::Result<()> {
    super::protocol::write(&mut *output.lock().map_err(|_| io::ErrorKind::BrokenPipe)?, event)
}

pub fn stream(mut input: impl Read + Send + 'static, output: Output, nonce: String, name: &'static str, captured_limit: u64)
    -> thread::JoinHandle<io::Result<StreamSummary>> {
    thread::spawn(move || {
        let mut buffer = [0; DATA_BYTES];
        let mut bytes = 0u64;
        let mut captured = 0u64;
        let mut digest = Sha256::new();
        let mut prefix = Sha256::new();
        loop {
            let size = input.read(&mut buffer)?;
            if size == 0 { return Ok(StreamSummary { eof: true, bytes, captured_bytes: captured,
                sha256: format!("{:x}", digest.finalize()), captured_sha256: format!("{:x}", prefix.finalize()) }); }
            bytes = bytes.checked_add(size as u64).ok_or(io::ErrorKind::InvalidData)?;
            digest.update(&buffer[..size]);
            let keep = size.min(captured_limit.saturating_sub(captured) as usize);
            if keep > 0 {
                prefix.update(&buffer[..keep]);
                let hex = buffer[..keep].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
                emit(&output, &Event::Data { version: 2, nonce: &nonce, stream: name, hex: &hex })?;
                captured += keep as u64;
            }
        }
    })
}

pub fn ready(output: &Output, run: &Run, pid: u32, containment: &str) -> io::Result<()> {
    emit(output, &Event::Ready { version: 2, nonce: &run.nonce, work_id: &run.work_id, command_id: &run.command_id,
        recipe_hash: &run.recipe_hash, control_revision: run.control_revision, root_pid: pid, containment })
}

pub fn elapsed(start: Instant) -> u64 { start.elapsed().as_millis().min(u64::MAX as u128) as u64 }

pub fn io_error<T>(code: &str) -> io::Result<T> { Err(io::Error::new(io::ErrorKind::PermissionDenied, code.to_owned())) }
