use crate::{no_follow, protocol::{Identity, Observation, PAGE_LIMIT, SCAN_LIMIT}};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read}, path::PathBuf, time::{Duration, Instant}};

pub struct Root {
    pub(crate) path: PathBuf,
    pub(crate) file: File,
    pub identity: Identity,
}

impl Root {
    pub fn open(path: &str, expected: Identity) -> io::Result<Self> {
        let value = Self::inspect(path)?;
        if value.identity != expected { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(value)
    }

    pub fn inspect(path: &str) -> io::Result<Self> {
        if path.is_empty() || path.len() > 2048 || path.chars().any(char::is_control) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let path = PathBuf::from(path);
        let file = no_follow::open_root(&path)?;
        let identity = no_follow::identity(&file)?;
        Ok(Self { path, file, identity })
    }

    pub fn current(&self) -> io::Result<()> {
        if no_follow::identity(&self.file)? != self.identity ||
            no_follow::identity(&no_follow::open_root(&self.path)?)? != self.identity {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }

    pub fn read(&self, relative: &str, offset: u64, length: u64, scan_limit: u64, deadline_ms: u64) -> io::Result<(Observation, Vec<u8>)> {
        if length == 0 || length > PAGE_LIMIT { return Err(io::ErrorKind::InvalidInput.into()); }
        self.scan(relative, offset, length, scan_limit, deadline_ms)
    }

    pub fn observe(&self, relative: &str, scan_limit: u64, deadline_ms: u64) -> io::Result<Observation> {
        // A separate fixed operation returns no content, including for binary files.
        // It does not relax the ordinary UTF-8 page reader's contract.
        self.scan(relative, 0, 0, scan_limit, deadline_ms).map(|(observation, _)| observation)
    }

    fn scan(&self, relative: &str, offset: u64, length: u64, scan_limit: u64, deadline_ms: u64) -> io::Result<(Observation, Vec<u8>)> {
        if scan_limit == 0 || scan_limit > SCAN_LIMIT ||
            deadline_ms == 0 || deadline_ms > 30_000 || offset.checked_add(length).is_none() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        self.current()?;
        let parts = no_follow::relative(relative)?;
        let mut file = no_follow::open_relative(&self.file, &parts)?;
        let before = no_follow::stamp(&file)?;
        let identity = no_follow::identity(&file)?;
        let file_bytes = file.metadata()?.len();
        if file_bytes > scan_limit || offset > file_bytes { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut hash = Sha256::new();
        let mut payload = Vec::with_capacity(length as usize);
        let mut buffer = [0; 65_536];
        let mut scanned = 0u64;
        loop {
            if Instant::now() >= deadline { return Err(io::ErrorKind::TimedOut.into()); }
            let read = file.read(&mut buffer)?;
            if read == 0 { break; }
            let end = scanned.checked_add(read as u64).ok_or(io::ErrorKind::InvalidData)?;
            if end > scan_limit { return Err(io::ErrorKind::InvalidData.into()); }
            hash.update(&buffer[..read]);
            let page_start = scanned.max(offset);
            let page_end = end.min(offset + length);
            if page_start < page_end { payload.extend_from_slice(&buffer[(page_start-scanned) as usize..(page_end-scanned) as usize]); }
            scanned = end;
        }
        self.current()?;
        if scanned != file_bytes || no_follow::stamp(&file)? != before ||
            no_follow::stamp(&no_follow::open_relative(&self.file, &parts)?)? != before || Instant::now() >= deadline {
            return Err(io::ErrorKind::InvalidData.into());
        }
        // An explicit byte offset must begin at a UTF-8 boundary. A bounded page may end
        // inside the next code point; retain only complete bytes and return its actual length.
        if let Err(error) = std::str::from_utf8(&payload) {
            if error.error_len().is_some() || offset + payload.len() as u64 >= file_bytes || error.valid_up_to() == 0 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            payload.truncate(error.valid_up_to());
        }
        // Hashes describe the actual bounded byte stream read from this descriptor. Stable
        // metadata is a change detector, not a claim that the filesystem supplied a snapshot.
        Ok((Observation { identity, offset, file_bytes, scanned_bytes: scanned,
            observed_sha256: format!("{:x}", hash.finalize()),
            page_sha256: format!("{:x}", Sha256::digest(&payload)), snapshot: "stream_observation" }, payload))
    }
}
