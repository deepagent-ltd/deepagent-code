mod no_follow;
mod protocol;
mod root;
mod write;
#[cfg(target_os = "linux")]
mod linux_write_profile;
#[cfg(windows)]
mod write_windows;
#[cfg(windows)]
mod write_windows_cleanup;
mod binary;
mod snapshot;
mod command;
mod event_worktree;
mod event_cleanup;
#[cfg(windows)]
mod regular_file;
#[cfg(windows)]
mod native_windows;
#[cfg(windows)]
mod snapshot_windows;

use protocol::{Request, Response};
use std::io;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--command-exec") {
        // This fixed mode is launched only by the host under its OS sandbox. A JSON
        // descriptor is not authority; no project FD survives into the executable.
        if command::exec().is_err() { std::process::exit(111); }
        return;
    }
    if run().is_err() { std::process::exit(2); }
}

fn run() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut root: Option<root::Root> = None;
    let mut prepared = None;
    let mut write_started = false;
    #[cfg(target_os = "linux")]
    let mut linux_write_profile: Option<linux_write_profile::Profile> = None;
    #[cfg(target_os = "linux")]
    let mut linux_managed_write = false;
    #[cfg(windows)]
    let mut write_stage_attempted = false;
    #[cfg(windows)]
    let mut cold_write_attempted = false;
    #[cfg(windows)]
    let mut cold_write_collector = None;
    let mut write_stage = None;
    let mut cleanup_allowed = false;
    let mut completed = 0u32;
    let mut binary_completed = 0u32;
    let mut captures = std::collections::HashMap::new();
    let mut snapshot_started = false;
    let mut event_tree = None;
    let mut observed_tree = None;
    let mut event_tree_started = false;
    let mut event_tree_requests = 0u32;
    while let Some(request) = protocol::read(&mut input)? {
        let tree_request = matches!(request, Request::EventTreeCollect { .. } | Request::EventObjectAllocation { .. } | Request::EventBaselineBegin { .. } | Request::EventBaselineNames { .. } | Request::EventTreeBegin { .. } | Request::EventTreeLeaf { .. } | Request::EventTreeObserveBegin { .. } | Request::EventTreeObserveLeaf { .. } | Request::EventTreeObserveFinish { .. } |
            Request::EventTreeChunk { .. } | Request::EventTreePublish { .. } | Request::EventTreeFinish { .. });
        let binary_request = matches!(request, Request::InspectBinaryDestination { .. } | Request::ObserveBinary { .. } | Request::OpenBinary { .. } |
            Request::ReadBinary { .. } | Request::SealBinary { .. } | Request::CleanupBinaryStage { .. } | Request::PrepareBinaryWrite { .. });
        if tree_request {
            event_tree_requests = event_tree_requests.checked_add(1).ok_or(io::ErrorKind::InvalidData)?;
            if event_tree_requests > 28_674 { return Err(io::ErrorKind::InvalidData.into()); }
        } else if binary_request {
            binary_completed = binary_completed.checked_add(1).ok_or(io::ErrorKind::InvalidData)?;
            if binary_completed > if observed_tree.is_some() { 32_768 } else { binary::REQUESTS } { return Err(io::ErrorKind::InvalidData.into()); }
        } else {
            completed = completed.checked_add(1).ok_or(io::ErrorKind::InvalidData)?;
            if completed > 4096 { return Err(io::ErrorKind::InvalidData.into()); }
        }
        let id = request.id();
        let mut response = Response { version: 1, id, status: "refused", code: Some("FILE_SCOPE_UNAVAILABLE"),
            root: None, observation: None, allocated_bytes: None, write: None, preparation: None, write_stage: None, snapshot: None, destination_parent: None, capture_id: None, binary_complete: None,
            #[cfg(target_os = "linux")] linux_write_profile: None, payload_bytes: 0 };
        let mut payload = Vec::new();
        match &request {
            #[cfg(target_os = "linux")]
            Request::LinuxWriteCapabilities { data, .. } if !write_started && !event_tree_started && !snapshot_started => {
                if let Some(root) = &root {
                    if linux_write_profile.is_none() {
                        linux_write_profile = linux_write_profile::Profile::enter(&root.path.to_string_lossy(), data).ok();
                    }
                    if let Some(profile) = &linux_write_profile {
                        if profile.description.data_identity == no_follow::identity(&no_follow::open_root(std::path::Path::new(data))?)? &&
                            profile.description.project_identity == root.identity && profile.current().is_ok() && root.current().is_ok() {
                            response.status = "linux_write_profile_v1"; response.code = None;
                            response.root = Some(root.identity.clone()); response.linux_write_profile = serde_json::to_value(&profile.description).ok();
                        }
                    }
                }
            },
            Request::EventTreeCollect { files, bytes, manifest_sha256, deadline_ms, .. } if !event_tree_started && !write_started && !snapshot_started => {
                event_tree_started = true;
                if let Some(root) = &root {
                    match event_cleanup::clear(root, *files, *bytes, manifest_sha256, *deadline_ms) {
                        Ok(bytes) => { response.status = "tree_collected"; response.code = None; response.root = Some(root.identity.clone()); response.allocated_bytes = Some(bytes); },
                        Err(event_cleanup::Failure::Unknown) => { response.status = "unknown"; response.code = Some("FILE_SCOPE_UNKNOWN"); },
                        Err(event_cleanup::Failure::BeforeMutation) => {},
                    }
                }
            },
            Request::EventTreeCapabilities { .. } if root.is_none() && completed == 1 => {
                response.status = "event_tree_observation_v1"; response.code = None;
            },
            Request::EventCustodyHeadroom { reservation_bytes, git, .. } => {
                if let Some(root) = &root {
                    if event_worktree::headroom(root, *reservation_bytes).and_then(|unit| git.as_ref().map_or(Ok(()), |plan|
                        event_worktree::git_allocation_bound(unit, *reservation_bytes, plan))).is_ok() {
                        response.status = "custody_ready"; response.code = None; response.root = Some(root.identity.clone());
                    }
                }
            },
            Request::EventObjectAllocation { relative, .. } => {
                if let Some(root) = &root {
                    if let Ok(bytes) = event_worktree::object_allocation(root, relative) {
                        response.status = "object_allocated"; response.code = None; response.root = Some(root.identity.clone()); response.allocated_bytes = Some(bytes);
                    }
                }
            },
            Request::EventTreeObserveBegin { deadline_ms, .. } if !event_tree_started && !write_started && !snapshot_started => {
                event_tree_started = true;
                if let Some(root) = &root {
                    if let Ok(value) = event_worktree::ObservedTree::begin(root, *deadline_ms).inspect_err(|error|
                        eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_observe_begin {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0))) {
                        observed_tree = Some(value); response.status = "tree_observe_ready"; response.code = None; response.root = Some(root.identity.clone());
                    }
                }
            },
            Request::EventBaselineBegin { read, deny, deadline_ms, .. } if !event_tree_started && !write_started && !snapshot_started => {
                event_tree_started = true;
                if let Some(root) = &root {
                    if let Ok(value) = event_worktree::ObservedTree::baseline(root, read.clone(), deny.clone(), *deadline_ms).inspect_err(|error|
                        eprintln!("DAC_EVENT_NATIVE_PHASE event_baseline_begin {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0))) {
                        observed_tree = Some(value); response.status = "baseline_observe_ready"; response.code = None; response.root = Some(root.identity.clone());
                    }
                }
            },
            Request::EventBaselineNames { offset, .. } => {
                if let (Some(root), Some(tree)) = (&root, &observed_tree) {
                    if root.current().is_ok() {
                        if let Ok((names, complete)) = tree.names_page(*offset) {
                            response.status = "baseline_names"; response.code = None; response.root = Some(root.identity.clone());
                            response.binary_complete = Some(complete); payload = names; response.payload_bytes = payload.len();
                        }
                    }
                }
            },
            Request::EventTreeObserveLeaf { relative, .. } => {
                if let (Some(root), Some(tree)) = (&root, &mut observed_tree) {
                    if let Ok((observation, executable)) = tree.leaf(root, relative) {
                        response.status = if executable { "tree_observed_executable" } else { "tree_observed" };
                        response.code = None; response.root = Some(root.identity.clone()); response.observation = Some(observation);
                    }
                }
            },
            Request::EventTreeObserveFinish { .. } => {
                if let (Some(root), Some(tree)) = (&root, observed_tree.take()) {
                    if let Ok(value) = tree.finish(root) {
                        response.status = "tree_observe_completed"; response.code = None; response.root = Some(value.root.clone());
                        response.allocated_bytes = Some(value.allocated_bytes);
                        response.snapshot = Some(snapshot::Snapshot { workspace: value.root, manifest_sha256: value.manifest_sha256,
                            files: value.files as usize, bytes: value.bytes, output_files: 0 });
                    }
                }
            },
            Request::EventTreeBegin { files, bytes, manifest_sha256, deadline_ms, .. } if !event_tree_started && !write_started && !snapshot_started => {
                event_tree_started = true;
                if let Some(root) = &root {
                    if let Ok(value) = event_worktree::Tree::begin(root, *files, *bytes, manifest_sha256, *deadline_ms).inspect_err(|error|
                        eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_begin {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0))) {
                        event_tree = Some(value); response.status = "tree_ready"; response.code = None; response.root = Some(root.identity.clone());
                    }
                }
            },
            Request::EventTreeLeaf { id, relative, bytes, sha256, executable, .. } => {
                if let (Some(root), Some(tree)) = (&root, &mut event_tree) {
                    if tree.leaf(root, id, relative, *bytes, sha256, *executable).inspect_err(|error|
                        eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_leaf {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0))).is_ok() {
                        response.status = "tree_leaf"; response.code = None; response.root = Some(root.identity.clone());
                    } else { tree.invalid(); if tree.partial() { response.status = "unknown"; response.code = Some("TREE_MATERIALIZATION_UNKNOWN"); } }
                }
            },
            Request::EventTreeChunk { offset, hex, .. } => {
                if let (Some(root), Some(tree)) = (&root, &mut event_tree) {
                    if tree.chunk(root, *offset, hex).inspect_err(|error|
                        eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_chunk {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0))).is_ok() {
                        response.status = "tree_written"; response.code = None; response.root = Some(root.identity.clone());
                    } else { tree.invalid(); if tree.partial() { response.status = "unknown"; response.code = Some("TREE_MATERIALIZATION_UNKNOWN"); } }
                }
            },
            Request::EventTreePublish { .. } => {
                if let (Some(root), Some(tree)) = (&root, &mut event_tree) {
                    match tree.publish(root) {
                        Ok(()) => { response.status = "tree_published"; response.code = None; response.root = Some(root.identity.clone()); },
                        Err(event_worktree::Failure::Unknown) => { eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_publish Unknown 0"); response.status = "unknown"; response.code = Some("TREE_MATERIALIZATION_UNKNOWN"); },
                        Err(event_worktree::Failure::BeforePublish) => {
                            eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_publish BeforePublish 0");
                            if tree.partial() { response.status = "unknown"; response.code = Some("TREE_MATERIALIZATION_UNKNOWN"); }
                        },
                    }
                }
            },
            Request::EventTreeFinish { .. } => {
                if let (Some(root), Some(tree)) = (&root, event_tree.take()) {
                    let partial = tree.partial();
                    match tree.finish(root).inspect_err(|error|
                        eprintln!("DAC_EVENT_NATIVE_PHASE event_tree_finish {:?} {}", error.kind(), error.raw_os_error().unwrap_or(0))) {
                        Ok(value) => { response.status = "tree_completed"; response.code = None; response.root = Some(value.root.clone());
                            response.allocated_bytes = Some(value.allocated_bytes);
                            response.snapshot = Some(snapshot::Snapshot { workspace: value.root, manifest_sha256: value.manifest_sha256,
                                files: value.files as usize, bytes: value.bytes, output_files: 0 }); },
                        Err(_) if partial => { response.status = "unknown"; response.code = Some("TREE_MATERIALIZATION_UNKNOWN"); },
                        Err(_) => {},
                    }
                }
            },
            Request::CleanupBinaryStage { stage, stage_identity, .. } if !write_started || cleanup_allowed => {
                if let Some(root) = &root {
                    if write::cleanup(root, stage, stage_identity).is_ok() {
                        response.status = "cleaned"; response.code = None;
                    }
                }
            },
            Request::InspectBinaryDestination { relative, deadline_ms, .. } => {
                if let Some(root) = &root {
                    if let Ok(value) = write::inspect_destination(root, relative, *deadline_ms) {
                        response.status = "missing"; response.code = None; response.root = Some(root.identity.clone());
                        response.destination_parent = Some(value);
                    }
                }
            },
            Request::ObserveBinary { relative, scan_limit, deadline_ms, .. } => {
                if let Some(root) = &root {
                    match binary::observe(root, relative, *scan_limit, *deadline_ms) {
                        Ok(value) => { response.status = "observed"; response.code = None;
                            response.root = Some(root.identity.clone()); response.observation = Some(value); },
                        Err(error) if error.kind() == io::ErrorKind::NotFound && root.current().is_ok() => {
                            response.status = "missing"; response.code = None; response.root = Some(root.identity.clone());
                        },
                        Err(_) => {},
                    }
                }
            },
            Request::OpenBinary { id, relative, expected: protocol::WriteExpected::Observed { identity, sha256, bytes }, deadline_ms, .. }
                if captures.len() < binary::CAPTURES && !captures.contains_key(id) => {
                if let Some(root) = &root {
                    if let Ok((capture, value)) = binary::Capture::open(root, relative, identity, *bytes, sha256, *deadline_ms) {
                        captures.insert(id.clone(), capture);
                        response.status = "observed"; response.code = None; response.root = Some(root.identity.clone());
                        response.capture_id = Some(id.clone()); response.observation = Some(value);
                    }
                }
            },
            Request::SealBinary { capture_id, deadline_ms, .. } => {
                if let (Some(root), Some(capture)) = (&root, captures.remove(capture_id)) {
                    if let Ok(value) = capture.seal(root, *deadline_ms) {
                        response.status = "observed"; response.code = None; response.root = Some(root.identity.clone());
                        response.observation = Some(value); response.binary_complete = Some(true);
                    }
                }
            },
            Request::ReadBinary { capture_id, offset, length, deadline_ms, .. } => {
                if let (Some(root), Some(mut capture)) = (&root, captures.remove(capture_id)) {
                    // Errors consume the capture; failed or repeated leaves cannot reuse its FD.
                    if let Ok((value, bytes, complete)) = capture.read(root, *offset, *length, *deadline_ms) {
                        response.status = "observed"; response.code = None; response.root = Some(root.identity.clone());
                        response.observation = Some(value); response.payload_bytes = bytes.len(); payload = bytes;
                        response.binary_complete = Some(complete);
                        captures.insert(capture_id.clone(), capture);
                    }
                }
            },
            Request::PrepareBinaryWrite { id, relative, stage, stage_identity, bytes, sha256,
                expected: protocol::WriteExpected::Missing, deadline_ms, .. } if !write_started && !event_tree_started => {
                write_started = true;
                write_stage = Some((stage.clone(), stage_identity.clone()));
                if let Some(root) = &root {
                    match write::Prepared::prepare_binary(root, id, relative, stage, stage_identity, *bytes, sha256, *deadline_ms) {
                        Ok(value) => { response.preparation = Some(value.description()); prepared = Some(value);
                            response.status = "prepared"; response.code = None; },
                        Err(_) => { cleanup_allowed = true; },
                    }
                }
            },
            Request::SnapshotWorkspace { workspace, workspace_identity, inputs, outputs, deadline_ms, .. } if !snapshot_started && !write_started && !event_tree_started => {
                snapshot_started = true;
                if let Some(current) = &root {
                    if let Ok(value) = snapshot::prepare(current, workspace, workspace_identity, inputs, outputs, *deadline_ms) {
                        response.status = "snapshot_ready"; response.code = None; response.snapshot = Some(value);
                    }
                }
            },
            #[cfg(windows)]
            Request::InspectKnownWriteStage { data, basename, data_identity, base_identity, stage_identity, files, .. }
                if !cold_write_attempted && !write_stage_attempted && !write_started && !event_tree_started && !snapshot_started => {
                cold_write_attempted = true;
                write_started = true;
                if let Some(root) = &root {
                    if let Ok(value) = write_windows_cleanup::Collector::inspect(root, data, basename,
                        data_identity, base_identity, stage_identity, files) {
                        if let Ok(observed) = value.observation(root) {
                            response.status = "known_stage_observed"; response.code = None;
                            response.root = Some(root.identity.clone()); response.write_stage = Some(observed);
                            cold_write_collector = Some(value);
                        }
                    }
                }
            },
            #[cfg(windows)]
            Request::CollectKnownWriteStage { .. } => {
                if let (Some(root), Some(collector)) = (&root, cold_write_collector.as_mut()) {
                    match collector.collect(root) {
                        Ok(()) => { response.status = "known_stage_cleaned"; response.root = Some(root.identity.clone()); response.code = None; },
                        Err(_) => { response.status = "unknown"; response.code = Some("WRITE_OUTCOME_UNKNOWN"); },
                    }
                }
            },
            #[cfg(windows)]
            Request::WriteStageCapabilities { .. } if !write_stage_attempted && !write_started && !event_tree_started && !snapshot_started => {
                if let Some(root) = &root {
                    if root.current().is_ok() {
                        response.status = "work_write_stage_v2"; response.code = None; response.root = Some(root.identity.clone());
                    }
                }
            },
            #[cfg(windows)]
            Request::PrepareWriteStage { data, basename, .. } if !write_stage_attempted && !write_started && !event_tree_started && !snapshot_started => {
                // An interrupted or rejected create never opens a second stage.
                write_stage_attempted = true;
                if let Some(root) = &root {
                    if let Ok(value) = write_windows::prepare_stage(root, data, basename) {
                        write_stage = Some((value.directory.clone(), value.stage.clone()));
                        response.status = "stage_ready"; response.code = None; response.write_stage = Some(value);
                    }
                }
            },
            #[cfg(windows)]
            Request::InspectWriteStage { .. } => {
                if let Some(root) = &root {
                    if let Ok(value) = write_windows::inspect_stage(root) {
                        response.status = "stage_observed"; response.code = None; response.write_stage = Some(value);
                    }
                }
            },
            Request::PrepareWrite { id, relative, stage, stage_identity, content, expected, deadline_ms, .. } if !write_started && !event_tree_started => {
                #[cfg(target_os = "linux")]
                if linux_write_profile.as_ref().is_none_or(|profile| profile.current().is_err()) {
                    protocol::write(&mut output, &response, &[])?; continue;
                }
                #[cfg(target_os = "linux")]
                { linux_managed_write = true; }
                write_started = true;
                write_stage = Some((stage.clone(), stage_identity.clone()));
                if let Some(value) = &root {
                    match write::Prepared::prepare(value, id, relative, stage, stage_identity, content, expected, *deadline_ms) {
                        Ok(value) => { response.preparation = Some(value.description()); prepared = Some(value);
                            response.status = "prepared"; response.code = None; },
                        Err(_) => { cleanup_allowed = true; },
                    }
                }
            },
            Request::PublishWrite { prepared_id, .. } => {
                // Taking the prepared operation before entering the syscall makes every
                // outcome one-shot, including response loss and uncertain publication.
                #[cfg(target_os = "linux")]
                if linux_managed_write && linux_write_profile.as_ref().is_none_or(|profile| profile.current().is_err()) {
                    // A prepared operation is consumed even when its current confinement
                    // is lost. Unknown custody cannot be retried under another profile.
                    prepared.take(); response.status = "unknown"; response.code = Some("WRITE_OUTCOME_UNKNOWN");
                    protocol::write(&mut output, &response, &[])?; continue;
                }
                if let (Some(value), Some(current)) = (prepared.take(), &root) {
                    if value.id() == prepared_id {
                        match value.publish(current) {
                            Ok(value) => { response.status = "published"; response.code = None; response.write = Some(value); cleanup_allowed = true; },
                            Err(write::Failure::BeforePublish) => { cleanup_allowed = true; },
                            Err(write::Failure::Unknown) => { response.status = "unknown"; response.code = Some("WRITE_OUTCOME_UNKNOWN"); },
                        }
                    }
                }
            },
            Request::CleanupWrite { .. } if cleanup_allowed => {
                #[cfg(target_os = "linux")]
                if linux_managed_write && linux_write_profile.as_ref().is_none_or(|profile| profile.current().is_err()) {
                    protocol::write(&mut output, &response, &[])?; continue;
                }
                cleanup_allowed = false;
                if let (Some(root), Some((stage, identity))) = (&root, write_stage.take()) {
                    if write::cleanup(root, &stage, &identity).is_ok() {
                        response.status = "cleaned"; response.code = None;
                    }
                }
            },
            #[cfg(target_os = "linux")]
            Request::InspectLinuxWritePolicy { path, data, .. } if root.is_none() => {
                if let Ok(value) = root::Root::inspect(path) {
                    if let Ok(profile) = linux_write_profile::Profile::enter(path, data) {
                        if value.current().is_ok() && profile.current().is_ok() && profile.description.project_identity == value.identity {
                            response.status = "linux_write_profile_v1"; response.code = None; response.root = Some(value.identity.clone());
                            response.linux_write_profile = serde_json::to_value(&profile.description).ok();
                        }
                    }
                }
                // This standalone observation joins and closes every held descriptor. It
                // produces no Work, stage or reusable execution capability.
                protocol::write(&mut output, &response, &[])?;
                return Ok(());
            },
            Request::InspectRoot { path, .. } if root.is_none() => {
                if let Ok(value) = root::Root::inspect(path) {
                    if value.current().is_ok() {
                        response.status = "ready"; response.code = None; response.root = Some(value.identity.clone());
                    }
                }
                // Metadata observation grants no later read: the opened root is dropped here.
                protocol::write(&mut output, &response, &[])?;
                return Ok(());
            },
            Request::OpenRoot { path, expected, .. } if root.is_none() => {
                if let Ok(value) = root::Root::open(path, expected.clone()) {
                    response.status = "ready"; response.code = None; response.root = Some(value.identity.clone());
                    root = Some(value);
                }
            },
            Request::Read { relative, offset, length, scan_limit, deadline_ms, .. } => {
                if let Some(root) = &root {
                    if let Ok((observation, bytes)) = root.read(relative, *offset, *length, *scan_limit, *deadline_ms) {
                        response.status = "observed"; response.code = None; response.root = Some(root.identity.clone());
                        response.observation = Some(observation); response.payload_bytes = bytes.len(); payload = bytes;
                    }
                }
            },
            Request::Observe { relative, scan_limit, deadline_ms, .. } => {
                if let Some(root) = &root {
                    match root.observe(relative, *scan_limit, *deadline_ms) {
                        Ok(observation) => {
                            response.status = "observed"; response.code = None;
                            response.root = Some(root.identity.clone()); response.observation = Some(observation);
                        },
                        Err(error) if error.kind() == io::ErrorKind::NotFound && root.current().is_ok() => {
                            response.status = "missing"; response.code = None; response.root = Some(root.identity.clone());
                        },
                        Err(_) => {},
                    }
                }
            },
            Request::CheckRoot { .. } => {
                if let Some(root) = &root {
                    if root.current().is_ok() {
                        response.status = "ready"; response.code = None; response.root = Some(root.identity.clone());
                    }
                }
            },
            Request::Close { .. } => {
                captures.clear(); drop(root.take()); response.status = "closed"; response.code = None;
                protocol::write(&mut output, &response, &[])?;
                return Ok(());
            },
            _ => {},
        }
        match &request {
            Request::ReadBinary { .. } => protocol::write_binary(&mut output, &response, &payload)?,
            _ => protocol::write(&mut output, &response, &payload)?,
        }
    }
    Ok(())
}
