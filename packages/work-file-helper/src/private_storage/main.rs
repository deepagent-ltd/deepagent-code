//! Separate bounded private-settings/installation channel. This is not a Work tool,
//! a project-file API, or proof that its installed Windows image is trusted.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

#[cfg(windows)]
#[path = "../no_follow/windows.rs"]
mod no_follow;
#[cfg(windows)]
#[path = "../regular_file.rs"]
mod regular_file;
#[cfg(windows)]
#[path = "../native_windows/private_directory.rs"]
mod private_directory;
#[cfg(windows)]
mod windows;

mod protocol {
    use serde::{Deserialize, Serialize};
    #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    pub enum Identity {
        Windows { volume_serial: String, file_id: String },
    }
}

const FRAME: usize = 65_536;
const MAX_BYTES: usize = 1_048_576;
const MAX_REQUESTS: usize = 32;

#[path = "protocol.rs"]
mod private_protocol;
use private_protocol::{Observation, Purpose};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Open { version: u8, id: String, parent: String, purpose: Purpose, prepare: bool, deadline_ms: u64 },
    Read { version: u8, id: String, name: String },
    Create { version: u8, id: String, name: String, bytes: usize, sha256: String },
    Replace { version: u8, id: String, name: String, expected: Observation, bytes: usize, sha256: String },
    Check { version: u8, id: String },
    Close { version: u8, id: String },
}

impl Request {
    fn id(&self) -> &str {
        match self { Self::Open { id, .. } | Self::Read { id, .. } | Self::Create { id, .. } |
            Self::Replace { id, .. } | Self::Check { id, .. } | Self::Close { id, .. } => id }
    }
    fn valid(&self) -> bool {
        let version = match self { Self::Open { version, .. } | Self::Read { version, .. } |
            Self::Create { version, .. } | Self::Replace { version, .. } |
            Self::Check { version, .. } | Self::Close { version, .. } => version };
        *version == 1 && self.id().len() == 32 && hex(self.id()) && match self {
            Self::Open { parent, deadline_ms, .. } => !parent.is_empty() && parent.len() <= 2048 &&
                !parent.chars().any(char::is_control) && *deadline_ms > 0 && *deadline_ms <= 30_000,
            Self::Create { bytes, sha256, .. } => *bytes <= MAX_BYTES && digest(sha256),
            Self::Replace { expected, bytes, sha256, .. } => *bytes <= MAX_BYTES && digest(sha256) &&
                expected.bytes <= MAX_BYTES as u64 && expected.stamp.len() <= 1024 && digest(&expected.sha256) &&
                match &expected.identity { protocol::Identity::Windows { volume_serial, file_id } =>
                    volume_serial.len() == 16 && file_id.len() == 32 && hex(volume_serial) && hex(file_id) },
            _ => true,
        }
    }
    fn payload_bytes(&self) -> usize {
        match self { Self::Create { bytes, .. } | Self::Replace { bytes, .. } => *bytes, _ => 0 }
    }
}

#[derive(Serialize)]
struct Response<'a> {
    version: u8,
    id: &'a str,
    status: &'a str,
    code: Option<&'a str>,
    parent: Option<protocol::Identity>,
    observation: Option<Observation>,
    payload_bytes: usize,
}

fn hex(value: &str) -> bool { value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
fn digest(value: &str) -> bool { value.len() == 64 && hex(value) }

fn read(input: &mut impl Read) -> io::Result<Option<(Request, Vec<u8>)>> {
    let mut length = [0u8; 4];
    match input.read(&mut length[..1])? { 0 => return Ok(None), 1 => {}, _ => unreachable!() }
    input.read_exact(&mut length[1..])?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > FRAME { return Err(io::ErrorKind::InvalidData.into()); }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    let request: Request = serde_json::from_slice(&body).map_err(|_| io::ErrorKind::InvalidData)?;
    if !request.valid() { return Err(io::ErrorKind::InvalidData.into()); }
    let mut payload = vec![0u8; request.payload_bytes()];
    input.read_exact(&mut payload)?;
    Ok(Some((request, payload)))
}

fn reply(output: &mut impl Write, response: &Response<'_>, payload: &[u8]) -> io::Result<()> {
    let body = serde_json::to_vec(response)?;
    if body.len() > FRAME || payload.len() > MAX_BYTES || response.payload_bytes != payload.len() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    output.write_all(&(body.len() as u32).to_be_bytes())?;
    output.write_all(&body)?;
    output.write_all(payload)?;
    output.flush()
}

fn main() { if run().is_err() { std::process::exit(2); } }

fn run() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    #[cfg(windows)]
    let mut lease = None;
    let mut opened = false;
    let mut requests = std::collections::HashSet::new();
    while let Some((request, payload)) = read(&mut input)? {
        if requests.len() == MAX_REQUESTS || !requests.insert(request.id().to_owned()) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut response = Response { version: 1, id: request.id(), status: "refused", code: Some("PRIVATE_STORAGE_UNAVAILABLE"),
            parent: None, observation: None, payload_bytes: 0 };
        let mut bytes = Vec::new();
        if let Request::Open { .. } = &request {
            if opened { return Err(io::ErrorKind::InvalidData.into()); }
            opened = true;
        }
        #[cfg(windows)]
        match &request {
            Request::Open { parent, purpose, prepare, deadline_ms, .. } => {
                if let Ok(value) = windows::Lease::open(parent, *purpose, *prepare, *deadline_ms) {
                    response.parent = Some(value.identity.clone());
                    response.status = "ready"; response.code = None; lease = Some(value);
                }
            },
            Request::Read { name, .. } => {
                if let Some(value) = &lease {
                    match value.read(name) {
                        Ok(None) => { response.status = "missing"; response.code = None; response.parent = Some(value.identity.clone()); },
                        Ok(Some((observation, content))) => { response.status = "observed"; response.code = None;
                            response.parent = Some(value.identity.clone()); response.observation = Some(observation); bytes = content; },
                        Err(_) => {},
                    }
                }
            },
            Request::Create { id, name, sha256, .. } | Request::Replace { id, name, sha256, .. } => {
                if let Some(value) = &lease {
                    let expected = match &request { Request::Replace { expected, .. } => Some(expected), _ => None };
                    match value.publish(name, id, &payload, sha256, expected) {
                        Ok(observation) => { response.status = "published"; response.code = None;
                            response.parent = Some(value.identity.clone()); response.observation = Some(observation); },
                        Err(windows::Failure::Unknown) => { response.status = "unknown"; response.code = Some("PRIVATE_STORAGE_PUBLICATION_UNKNOWN"); },
                        Err(windows::Failure::Changed) => { response.code = Some("PRIVATE_STORAGE_CHANGED"); },
                        Err(windows::Failure::BeforePublish) => {},
                    }
                }
            },
            Request::Check { .. } => {
                if let Some(value) = &lease {
                    if value.current().is_ok() { response.status = "current"; response.code = None; response.parent = Some(value.identity.clone()); }
                }
            },
            Request::Close { .. } => { lease.take(); response.status = "closed"; response.code = None; },
        }
        #[cfg(not(windows))]
        { let _ = &payload; if let Request::Close { .. } = &request { response.status = "closed"; response.code = None; } }
        response.payload_bytes = bytes.len();
        reply(&mut output, &response, &bytes)?;
        if matches!(request, Request::Close { .. }) { return Ok(()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(request: &serde_json::Value, payload: &[u8]) -> Vec<u8> {
        let body = serde_json::to_vec(request).unwrap();
        [(&(body.len() as u32).to_be_bytes()).as_slice(), &body, payload].concat()
    }
    #[test]
    fn bounded_frame_and_declared_raw_payload_are_not_json_expansion() {
        let valid = serde_json::json!({"op":"create","version":1,"id":"a".repeat(32),"name":"settings.json",
            "bytes":MAX_BYTES,"sha256":"b".repeat(64)});
        assert_eq!(read(&mut frame(&valid, &vec![255; MAX_BYTES]).as_slice()).unwrap().unwrap().1.len(), MAX_BYTES);
        let mut invalid = valid.clone(); invalid["bytes"] = (MAX_BYTES + 1).into();
        assert!(read(&mut frame(&invalid, &[]).as_slice()).is_err());
        assert!(read(&mut frame(&valid, &[0]).as_slice()).is_err());
        assert!(read(&mut (&((FRAME + 1) as u32).to_be_bytes()).as_slice()).is_err());
    }
    #[test]
    fn identity_and_purpose_cannot_expand_to_other_private_files() {
        assert!(Purpose::Settings.permits("settings.json"));
        assert!(!Purpose::Settings.permits("account.json"));
        assert!(!Purpose::Settings.permits("../installation.json"));
        assert!(Purpose::LocalOperator.permits("installation.json"));
        assert!(!Purpose::LocalOperator.permits("settings.json"));
        let bad = serde_json::json!({"op":"replace","version":1,"id":"a".repeat(32),"name":"settings.json",
            "bytes":0,"sha256":"b".repeat(64),"expected":{"identity":{"kind":"windows","volume_serial":"c".repeat(16),
            "file_id":"../arbitrary"},"stamp":"x","bytes":0,"sha256":"b".repeat(64)}});
        assert!(read(&mut frame(&bad, &[]).as_slice()).is_err());
    }
}
