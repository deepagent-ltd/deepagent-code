//! Browser-purpose binary observations are separate from the bounded UTF-8 Work reader.
//! A held file is scanned once, then consumed continuously into a private host stage.
use crate::{no_follow, protocol::{Identity, Observation}, root::Root};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read, Seek, SeekFrom}, time::{Duration, Instant}};

pub const LIMIT: u64 = 52_428_800;
pub const BINARY_PAGE_LIMIT: u64 = 1_048_576;
pub const CAPTURES: usize = 4;
pub const REQUESTS: u32 = 8192;

pub struct Capture {
    file: File,
    relative: String,
    identity: Identity,
    stamp: String,
    bytes: u64,
    hash: String,
    offset: u64,
    stream: Sha256,
    deadline: Instant,
    finished: bool,
}

impl Capture {
    pub fn open(root: &Root, relative: &str, identity: &Identity, bytes: u64, hash: &str,
        deadline_ms: u64) -> io::Result<(Self, Observation)> {
        if bytes > LIMIT || !digest(hash) { return Err(io::ErrorKind::InvalidInput.into()); }
        let (mut file, observation, stamp, deadline) = scan(root, relative, LIMIT, deadline_ms)?;
        if observation.identity != *identity || observation.file_bytes != bytes || observation.observed_sha256 != hash {
            return Err(io::ErrorKind::InvalidData.into());
        }
        file.seek(SeekFrom::Start(0))?;
        Ok((Self { file, relative: relative.to_owned(), identity: identity.clone(), stamp,
            bytes, hash: hash.to_owned(), offset: 0, stream: Sha256::new(), deadline, finished: false }, observation))
    }

    pub fn read(&mut self, root: &Root, offset: u64, length: u64, deadline_ms: u64)
        -> io::Result<(Observation, Vec<u8>, bool)> {
        if self.finished || offset != self.offset || length == 0 || length > BINARY_PAGE_LIMIT || deadline_ms == 0 || deadline_ms > 30_000 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // A caller can shorten a leaf deadline, never renew the captured lifetime.
        let deadline = self.deadline.min(Instant::now() + Duration::from_millis(deadline_ms));
        self.current(root, deadline)?;
        let remaining = self.bytes.checked_sub(offset).ok_or(io::ErrorKind::InvalidData)?;
        let mut payload = vec![0; length.min(remaining) as usize];
        self.file.read_exact(&mut payload)?;
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        self.stream.update(&payload);
        self.offset = self.offset.checked_add(payload.len() as u64).ok_or(io::ErrorKind::InvalidData)?;
        let complete = self.offset == self.bytes;
        if complete {
            let mut extra = [0; 1];
            if self.file.read(&mut extra)? != 0 || format!("{:x}", self.stream.clone().finalize()) != self.hash {
                return Err(io::ErrorKind::InvalidData.into());
            }
            self.finished = true;
        }
        self.current(root, deadline)?;
        Ok((Observation { identity: self.identity.clone(), offset, file_bytes: self.bytes,
            scanned_bytes: self.bytes, observed_sha256: self.hash.clone(),
            page_sha256: format!("{:x}", Sha256::digest(&payload)), snapshot: "stream_observation" }, payload, complete))
    }

    pub fn seal(self, root: &Root, deadline_ms: u64) -> io::Result<Observation> {
        if !self.finished || self.offset != self.bytes || deadline_ms == 0 || deadline_ms > 30_000 ||
            format!("{:x}", self.stream.clone().finalize()) != self.hash { return Err(io::ErrorKind::InvalidData.into()); }
        self.current(root, self.deadline.min(Instant::now() + Duration::from_millis(deadline_ms)))?;
        Ok(Observation { identity: self.identity.clone(), offset: self.offset, file_bytes: self.bytes,
            scanned_bytes: self.bytes, observed_sha256: self.hash.clone(),
            page_sha256: format!("{:x}", Sha256::digest([])), snapshot: "stream_observation" })
    }

    fn current(&self, root: &Root, deadline: Instant) -> io::Result<()> {
        root.current()?;
        if Instant::now() >= deadline || no_follow::stamp(&self.file)? != self.stamp ||
            no_follow::stamp(&no_follow::open_relative(&root.file, &no_follow::relative(&self.relative)?)?)? != self.stamp {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    }
}

pub fn observe(root: &Root, relative: &str, limit: u64, deadline_ms: u64) -> io::Result<Observation> {
    scan(root, relative, limit, deadline_ms).map(|(_, observation, _, _)| observation)
}

fn scan(root: &Root, relative: &str, limit: u64, deadline_ms: u64)
    -> io::Result<(File, Observation, String, Instant)> {
    if limit == 0 || limit > LIMIT || deadline_ms == 0 || deadline_ms > 30_000 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    root.current()?;
    let parts = no_follow::relative(relative)?;
    let mut file = no_follow::open_relative(&root.file, &parts)?;
    let stamp = no_follow::stamp(&file)?;
    let identity = no_follow::identity(&file)?;
    let bytes = file.metadata()?.len();
    if bytes > limit { return Err(io::ErrorKind::InvalidData.into()); }
    let mut scanned = 0u64;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
        let read = file.read(&mut buffer)?;
        if read == 0 { break; }
        scanned = scanned.checked_add(read as u64).ok_or(io::ErrorKind::InvalidData)?;
        if scanned > limit { return Err(io::ErrorKind::InvalidData.into()); }
        hash.update(&buffer[..read]);
    }
    root.current()?;
    if scanned != bytes || no_follow::stamp(&file)? != stamp ||
        no_follow::stamp(&no_follow::open_relative(&root.file, &parts)?)? != stamp || Instant::now() >= deadline {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok((file, Observation { identity, offset: 0, file_bytes: bytes, scanned_bytes: scanned,
        observed_sha256: format!("{:x}", hash.finalize()), page_sha256: format!("{:x}", Sha256::digest([])),
        snapshot: "stream_observation" }, stamp, deadline))
}

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
