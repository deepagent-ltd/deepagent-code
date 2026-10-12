use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const FRAME_LIMIT: usize = 65_536;
pub const PAGE_LIMIT: u64 = 51_200;
pub const BINARY_PAGE_LIMIT: u64 = 1_048_576;
pub const SCAN_LIMIT: u64 = 16_777_216;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathRule { pub kind: String, pub path: String }
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitAllocationPlan { pub files: u64, pub directories: u64, pub bytes: u64, pub index_bytes: u64, pub existing_bytes: u64 }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Identity {
    Posix { device: String, inode: String },
    Windows { volume_serial: String, file_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    OpenRoot { version: u8, id: String, path: String, expected: Identity },
    EventTreeCapabilities { version: u8, id: String },
    EventTreeCollect { version: u8, id: String, files: u64, bytes: u64, manifest_sha256: String, deadline_ms: u64 },
    EventTreeObserveBegin { version: u8, id: String, deadline_ms: u64 },
    EventBaselineBegin { version: u8, id: String, read: Vec<PathRule>, deny: Vec<PathRule>, deadline_ms: u64 },
    EventBaselineNames { version: u8, id: String, offset: usize },
    EventCustodyHeadroom { version: u8, id: String, reservation_bytes: u64, git: Option<GitAllocationPlan> },
    EventObjectAllocation { version: u8, id: String, relative: String },
    EventTreeObserveLeaf { version: u8, id: String, relative: String },
    EventTreeObserveFinish { version: u8, id: String },
    EventTreeBegin { version: u8, id: String, files: u64, bytes: u64, manifest_sha256: String, deadline_ms: u64 },
    EventTreeLeaf { version: u8, id: String, relative: String, bytes: u64, sha256: String, executable: bool },
    EventTreeChunk { version: u8, id: String, offset: u64, hex: String },
    EventTreePublish { version: u8, id: String },
    EventTreeFinish { version: u8, id: String },
    InspectRoot { version: u8, id: String, path: String },
    Read { version: u8, id: String, relative: String, offset: u64, length: u64, scan_limit: u64, deadline_ms: u64 },
    Observe { version: u8, id: String, relative: String, scan_limit: u64, deadline_ms: u64 },
    CheckRoot { version: u8, id: String },
    InspectBinaryDestination { version: u8, id: String, relative: String, deadline_ms: u64 },
    ObserveBinary { version: u8, id: String, relative: String, scan_limit: u64, deadline_ms: u64 },
    OpenBinary { version: u8, id: String, relative: String, expected: WriteExpected, deadline_ms: u64 },
    SealBinary { version: u8, id: String, capture_id: String, deadline_ms: u64 },
    ReadBinary { version: u8, id: String, capture_id: String, offset: u64, length: u64, deadline_ms: u64 },
    CleanupBinaryStage { version: u8, id: String, stage: String, stage_identity: Identity },
    PrepareBinaryWrite { version: u8, id: String, relative: String, stage: String, stage_identity: Identity,
        bytes: u64, sha256: String, expected: WriteExpected, deadline_ms: u64 },
    PrepareWrite { version: u8, id: String, relative: String, stage: String, stage_identity: Identity,
        content: String, expected: WriteExpected, deadline_ms: u64 },
    PrepareWriteStage { version: u8, id: String, data: String, basename: String },
    InspectWriteStage { version: u8, id: String },
    WriteStageCapabilities { version: u8, id: String },
    LinuxWriteCapabilities { version: u8, id: String, data: String },
    InspectLinuxWritePolicy { version: u8, id: String, path: String, data: String },
    InspectKnownWriteStage { version: u8, id: String, data: String, basename: String,
        data_identity: Identity, base_identity: Identity, stage_identity: Identity, files: Vec<WriteStageFile> },
    CollectKnownWriteStage { version: u8, id: String },
    PublishWrite { version: u8, id: String, prepared_id: String },
    CleanupWrite { version: u8, id: String },
    SnapshotWorkspace { version: u8, id: String, workspace: String, workspace_identity: Identity,
        inputs: Vec<crate::snapshot::Input>, outputs: Vec<String>, deadline_ms: u64 },
    Close { version: u8, id: String },
}

impl Request {
    pub fn id(&self) -> &str {
        match self { Self::EventTreeCollect { id, .. } | Self::EventObjectAllocation { id, .. } | Self::EventCustodyHeadroom { id, .. } | Self::EventBaselineBegin { id, .. } | Self::EventBaselineNames { id, .. } | Self::EventTreeCapabilities { id, .. } | Self::EventTreeObserveBegin { id, .. } | Self::EventTreeObserveLeaf { id, .. } | Self::EventTreeObserveFinish { id, .. } | Self::EventTreeBegin { id, .. } | Self::EventTreeLeaf { id, .. } | Self::EventTreeChunk { id, .. } | Self::EventTreePublish { id, .. } | Self::EventTreeFinish { id, .. } | Self::OpenRoot { id, .. } | Self::InspectRoot { id, .. } | Self::Read { id, .. } | Self::Observe { id, .. } | Self::CheckRoot { id, .. } | Self::InspectBinaryDestination { id, .. } | Self::ObserveBinary { id, .. } | Self::OpenBinary { id, .. } | Self::SealBinary { id, .. } | Self::ReadBinary { id, .. } | Self::CleanupBinaryStage { id, .. } | Self::PrepareBinaryWrite { id, .. } | Self::PrepareWrite { id, .. } | Self::PrepareWriteStage { id, .. } | Self::InspectWriteStage { id, .. } | Self::WriteStageCapabilities { id, .. } | Self::LinuxWriteCapabilities { id, .. } | Self::InspectLinuxWritePolicy { id, .. } | Self::InspectKnownWriteStage { id, .. } | Self::CollectKnownWriteStage { id, .. } | Self::PublishWrite { id, .. } | Self::CleanupWrite { id, .. } | Self::SnapshotWorkspace { id, .. } | Self::Close { id, .. } => id }
    }
    pub fn valid(&self) -> bool {
        let version = match self { Self::EventTreeCollect { version, .. } | Self::EventObjectAllocation { version, .. } | Self::EventCustodyHeadroom { version, .. } | Self::EventBaselineBegin { version, .. } | Self::EventBaselineNames { version, .. } | Self::EventTreeCapabilities { version, .. } | Self::EventTreeObserveBegin { version, .. } | Self::EventTreeObserveLeaf { version, .. } | Self::EventTreeObserveFinish { version, .. } | Self::EventTreeBegin { version, .. } | Self::EventTreeLeaf { version, .. } | Self::EventTreeChunk { version, .. } | Self::EventTreePublish { version, .. } | Self::EventTreeFinish { version, .. } | Self::OpenRoot { version, .. } | Self::InspectRoot { version, .. } | Self::Read { version, .. } | Self::Observe { version, .. } | Self::CheckRoot { version, .. } | Self::InspectBinaryDestination { version, .. } | Self::ObserveBinary { version, .. } | Self::OpenBinary { version, .. } | Self::SealBinary { version, .. } | Self::ReadBinary { version, .. } | Self::CleanupBinaryStage { version, .. } | Self::PrepareBinaryWrite { version, .. } | Self::PrepareWrite { version, .. } | Self::PrepareWriteStage { version, .. } | Self::InspectWriteStage { version, .. } | Self::WriteStageCapabilities { version, .. } | Self::LinuxWriteCapabilities { version, .. } | Self::InspectLinuxWritePolicy { version, .. } | Self::InspectKnownWriteStage { version, .. } | Self::CollectKnownWriteStage { version, .. } | Self::PublishWrite { version, .. } | Self::CleanupWrite { version, .. } | Self::SnapshotWorkspace { version, .. } | Self::Close { version, .. } => version };
        *version == 1 && !self.id().is_empty() && self.id().len() <= 128 && self.id().bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WriteExpected {
    Missing,
    Observed { identity: Identity, sha256: String, bytes: u64 },
}

#[derive(Serialize)]
pub struct WriteObservation {
    pub parent: Identity,
    pub stage: Identity,
    pub file: Identity,
    pub sha256: String,
    pub bytes: u64,
    pub previous: WriteExpected,
    pub publication: &'static str,
}

#[derive(Serialize)]
pub struct WritePreparation { pub parent: Identity, pub stage: Identity }

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WriteStageFile { pub relative: String, pub identity: Identity, pub sha256: String,
    pub bytes: u64, pub retained_unlinked: bool }
#[derive(Serialize)]
pub struct WriteStageObservation { pub version: u8, pub directory: String, pub data: Identity,
    pub base: Identity, pub stage: Identity, pub root: Identity, pub files: Vec<WriteStageFile>, pub retained_bytes: u64 }

#[derive(Serialize)]
pub struct Response<'a> {
    pub version: u8,
    pub id: &'a str,
    pub status: &'a str,
    pub code: Option<&'a str>,
    pub root: Option<Identity>,
    pub observation: Option<Observation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocated_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write: Option<WriteObservation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preparation: Option<WritePreparation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_stage: Option<WriteStageObservation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<crate::snapshot::Snapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_parent: Option<Identity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_complete: Option<bool>,
    #[cfg(target_os = "linux")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linux_write_profile: Option<serde_json::Value>,
    pub payload_bytes: usize,
}

#[derive(Serialize)]
pub struct Observation {
    pub identity: Identity,
    pub offset: u64,
    pub file_bytes: u64,
    pub scanned_bytes: u64,
    pub observed_sha256: String,
    pub page_sha256: String,
    pub snapshot: &'static str,
}

pub fn read(input: &mut impl Read) -> io::Result<Option<Request>> {
    let mut length = [0; 4];
    match input.read(&mut length[..1])? { 0 => return Ok(None), 1 => {}, _ => unreachable!() }
    input.read_exact(&mut length[1..])?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > FRAME_LIMIT { return Err(io::ErrorKind::InvalidData.into()); }
    let mut body = vec![0; length];
    input.read_exact(&mut body)?;
    let request: Request = serde_json::from_slice(&body).map_err(|_| io::ErrorKind::InvalidData)?;
    if !request.valid() { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(Some(request))
}

pub fn write(output: &mut impl Write, response: &Response<'_>, payload: &[u8]) -> io::Result<()> {
    write_bounded(output, response, payload, PAGE_LIMIT)
}

// Only ReadBinary dispatch may use this bound; the Work reader and all JSON
// request/metadata frames retain their original limits.
pub fn write_binary(output: &mut impl Write, response: &Response<'_>, payload: &[u8]) -> io::Result<()> {
    write_bounded(output, response, payload, BINARY_PAGE_LIMIT)
}

fn write_bounded(output: &mut impl Write, response: &Response<'_>, payload: &[u8], limit: u64) -> io::Result<()> {
    let body = serde_json::to_vec(response)?;
    if body.len() > FRAME_LIMIT || payload.len() as u64 > limit || response.payload_bytes != payload.len() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    output.write_all(&(body.len() as u32).to_be_bytes())?;
    output.write_all(&body)?;
    output.write_all(payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_binary_writer_does_not_expand_work_or_metadata_frames() {
        let mut response = Response { version: 1, id: "frame", status: "observed", code: None,
            root: None, observation: None, allocated_bytes: None, write: None, preparation: None, write_stage: None, snapshot: None,
            destination_parent: None, capture_id: None, binary_complete: None, payload_bytes: 0 };
        let payload = vec![0; BINARY_PAGE_LIMIT as usize];
        response.payload_bytes = payload.len();
        assert!(write(&mut Vec::new(), &response, &payload).is_err());
        assert!(write_binary(&mut Vec::new(), &response, &payload).is_ok());
        response.payload_bytes += 1;
        assert!(write_binary(&mut Vec::new(), &response, &payload).is_err());
        let oversized = vec![0; response.payload_bytes];
        assert!(write_binary(&mut Vec::new(), &response, &oversized).is_err());
        response.payload_bytes = 0;
        let long_id = "x".repeat(FRAME_LIMIT);
        response.id = &long_id;
        assert!(write_binary(&mut Vec::new(), &response, &[]).is_err());
    }
}
