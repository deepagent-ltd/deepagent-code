//! A new original helper may collect known terminal write custody. It does not
//! reconstruct Prepared, replace a project member or recover unknown execution.
use crate::{no_follow::{self, LockedPath}, native_windows::private_directory,
    protocol::{Identity, WriteStageFile, WriteStageObservation}, root::Root, write_windows};
use std::{collections::BTreeMap, fs::File, io, path::{Path, PathBuf}, ptr, time::{Duration, Instant}};
use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_DELETE};

pub struct Collector {
    data: LockedPath, base: LockedPath, project: LockedPath, stage: Option<LockedPath>,
    directory: PathBuf, basename: String, identity: Identity,
    files: BTreeMap<String, (File, WriteStageFile)>, unknown: bool, cleaned: bool,
}
impl Collector {
    pub fn inspect(root: &Root, data: &str, basename: &str, data_identity: &Identity, base_identity: &Identity,
        stage_identity: &Identity, expected: &[WriteStageFile]) -> io::Result<Self> {
        if basename.len() != 32 || !basename.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) ||
            Path::new(data) != write_windows::fixed_data_root()? || expected.len() > 1 || expected.iter().any(|file|
                file.relative != "payload" || file.retained_unlinked || file.bytes > 51_200 || file.sha256.len() != 64 ||
                !file.sha256.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        root.current()?;
        let data = LockedPath::open(Path::new(data), true, false)?;
        let base_path = write_windows::fixed_data_root()?.join("work-write-stage");
        let base = LockedPath::open(&base_path, true, false)?;
        let project = LockedPath::open(&root.path, true, false)?;
        if no_follow::identity(&data.file)? != *data_identity || no_follow::identity(&base.file)? != *base_identity ||
            no_follow::identity(&project.file)? != root.identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        private_directory::require_private(&base.file)?;
        write_windows::same_volume(base_identity, &root.identity)?;
        write_windows::same_volume(stage_identity, &root.identity)?;
        let directory = base_path.join(basename);
        if write_windows::overlaps(&base.canonical().join(basename), project.canonical()) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let stage = LockedPath::open(&directory, true, false)?;
        private_directory::require_private(&stage.file)?;
        if no_follow::identity(&stage.file)? != *stage_identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        let reader = write_windows::open(&base.file, basename, true, FILE_GENERIC_READ, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE)?;
        if no_follow::identity(&reader)? != *stage_identity || no_follow::final_path(&reader)? != stage.canonical() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let names = write_windows::names(&reader)?;
        if names.len() != expected.len() || expected.iter().any(|file| !names.contains(&file.relative)) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let mut files = BTreeMap::new();
        for expected in expected {
            let file = write_windows::open(&stage.file, &expected.relative, false, FILE_GENERIC_READ | 0x0001_0000,
                1, ptr::null(), FILE_SHARE_READ)?;
            private_directory::require_private(&file)?;
            write_windows::named_file(&file, stage.canonical(), &expected.relative)?;
            if write_windows::accessible_links(&file)? != 1 || no_follow::identity(&file)? != expected.identity ||
                write_windows::observe(&file, Instant::now() + Duration::from_secs(10))? != (expected.sha256.clone(), expected.bytes) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            files.insert(expected.relative.clone(), (file, WriteStageFile { relative: expected.relative.clone(), identity: expected.identity.clone(),
                sha256: expected.sha256.clone(), bytes: expected.bytes, retained_unlinked: false }));
        }
        let result = Self { data, base, project, stage: Some(stage), directory, basename: basename.to_owned(),
            identity: stage_identity.clone(), files, unknown: false, cleaned: false };
        result.current(root)?;
        Ok(result)
    }
    pub fn observation(&self, root: &Root) -> io::Result<WriteStageObservation> {
        self.current(root)?;
        Ok(WriteStageObservation { version: 1, directory: self.directory.to_string_lossy().into_owned(), data: no_follow::identity(&self.data.file)?,
            base: no_follow::identity(&self.base.file)?, stage: self.identity.clone(), root: root.identity.clone(),
            retained_bytes: self.files.values().map(|(_, fact)| fact.bytes).sum(), files: self.files.values().map(|(_, fact)| WriteStageFile {
                relative: fact.relative.clone(), identity: fact.identity.clone(), sha256: fact.sha256.clone(), bytes: fact.bytes, retained_unlinked: false }).collect() })
    }
    fn current(&self, root: &Root) -> io::Result<()> {
        if self.unknown || self.cleaned || Path::new(write_windows::fixed_data_root()?) != self.directory.parent().and_then(Path::parent).ok_or(io::ErrorKind::InvalidInput)? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        root.current()?; self.data.current()?; self.base.current()?; self.project.current()?;
        let stage = self.stage.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        stage.current()?; private_directory::require_private(&stage.file)?; private_directory::require_private(&self.base.file)?;
        if no_follow::identity(&self.project.file)? != root.identity || no_follow::identity(&stage.file)? != self.identity {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let reader = write_windows::open(&self.base.file, &self.basename, true, FILE_GENERIC_READ, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE)?;
        if no_follow::identity(&reader)? != self.identity || no_follow::final_path(&reader)? != stage.canonical() ||
            write_windows::names(&reader)? != self.files.keys().cloned().collect::<Vec<_>>() { return Err(io::ErrorKind::PermissionDenied.into()); }
        for (relative, (file, expected)) in &self.files {
            private_directory::require_private(file)?; write_windows::named_file(file, stage.canonical(), relative)?;
            if write_windows::accessible_links(file)? != 1 || no_follow::identity(file)? != expected.identity ||
                write_windows::observe(file, Instant::now() + Duration::from_secs(10))? != (expected.sha256.clone(), expected.bytes) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
        Ok(())
    }
    pub fn collect(&mut self, root: &Root) -> io::Result<()> {
        self.current(root)?;
        // The complete original inventory is checked before the first delete.
        // No missing directory or partial mutation can be inferred as success.
        self.unknown = true;
        for (file, _) in self.files.values() { write_windows::dispose(file)?; }
        self.files.clear();
        let stage = self.stage.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        let canonical = stage.canonical().to_owned();
        let reader = write_windows::open(&self.base.file, &self.basename, true, FILE_GENERIC_READ, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE)?;
        if no_follow::identity(&reader)? != self.identity || !write_windows::names(&reader)?.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        drop(reader); drop(self.stage.take());
        let removed = write_windows::open(&self.base.file, &self.basename, true, FILE_GENERIC_READ | 0x0001_0000,
            1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE)?;
        private_directory::require_private(&removed)?;
        if no_follow::identity(&removed)? != self.identity || no_follow::final_path(&removed)? != canonical || !write_windows::names(&removed)?.is_empty() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        write_windows::dispose(&removed)?; drop(removed);
        root.current()?; self.data.current()?; self.base.current()?; self.project.current()?;
        match write_windows::open(&self.base.file, &self.basename, true, FILE_READ_ATTRIBUTES, 1, ptr::null(), FILE_SHARE_READ | FILE_SHARE_DELETE) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}, _ => return Err(io::ErrorKind::PermissionDenied.into()),
        }
        self.cleaned = true;
        Ok(())
    }
}
