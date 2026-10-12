//! A fixed installed-artifact reader, never a user-selected path or work permit.
use super::{loader::FirstLoad, preload::Evidence};
use crate::no_follow::{self, LockedPath};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read, Seek, SeekFrom}};

pub struct Installed { manifest: LockedPath, description: Description }
#[derive(Serialize)]
struct Observation { identity: String, hash: String, bytes: u64, text: Option<String> }
#[derive(Serialize)]
struct Description { version: u8, artifact: Observation, manifest: Observation, runtime: Observation }
impl Installed {
    pub fn open(original: &FirstLoad, proof: &Evidence) -> io::Result<Self> {
        original.current()?; proof.current()?;
        proof.node_file()?;
        let directory = original.bootstrap_path()?.parent().ok_or(io::ErrorKind::Unsupported)?;
        let manifest = LockedPath::open(&directory.join(format!("{}.native-installation.json",proof.artifact_name()?)), false, false)?;
        super::loader::require_trusted(&manifest.file)?;
        let description = Description { version: 1, artifact: observe(proof.node_file()?, 268_435_456, false)?,
            manifest: observe(&manifest.file, 65_536, true)?, runtime: observe(original.original_host_file()?, 268_435_456, false)? };
        let installed = Self { manifest, description };
        installed.current(original, proof)?;
        Ok(installed)
    }
    pub fn read(&self, original: &FirstLoad, proof: &Evidence) -> io::Result<String> {
        self.current(original, proof)?;
        // These bytes were observed while the original capture's handles denied
        // WRITE/DELETE sharing. Reuse only inside that same live native capture;
        // every read still verifies its held image graph and all three stamps.
        let description = serde_json::to_string(&self.description).map_err(io::Error::other)?;
        self.current(original, proof)?;
        Ok(description)
    }
    fn current(&self, original: &FirstLoad, proof: &Evidence) -> io::Result<()> {
        original.current()?; proof.current()?; self.manifest.current()?;
        super::loader::require_trusted(&self.manifest.file)?; super::loader::require_trusted(proof.node_file()?)?;
        if no_follow::stamp(proof.node_file()?)? != self.description.artifact.identity
            || no_follow::stamp(&self.manifest.file)? != self.description.manifest.identity
            || no_follow::stamp(original.original_host_file()?)? != self.description.runtime.identity {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
}
fn observe(file: &File, limit: u64, text: bool) -> io::Result<Observation> {
    let identity = no_follow::stamp(file)?;
    let size = file.metadata()?.len();
    if size == 0 || size > limit { return Err(io::ErrorKind::InvalidData.into()); }
    let mut reader = file.try_clone()?; reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new(); let mut body = Vec::new(); let mut buffer = [0u8; 65_536]; let mut bytes = 0u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 { break; }
        bytes = bytes.checked_add(count as u64).ok_or(io::ErrorKind::InvalidData)?;
        if bytes > size { return Err(io::ErrorKind::PermissionDenied.into()); }
        hash.update(&buffer[..count]);
        if text { body.extend_from_slice(&buffer[..count]); }
    }
    if bytes != size || no_follow::stamp(file)? != identity { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(Observation { identity, hash: format!("{:x}", hash.finalize()), bytes,
        text: if text { Some(String::from_utf8(body).map_err(io::Error::other)?) } else { None } })
}
