//! Only the original preloaded module may issue this fixed Work image lease.
//! Paths and hashes come from adjacent publisher-attested installation files,
//! never from a JavaScript descriptor or a cold reconstructed image factory.
use super::{loader::{self, FirstLoad}, preload::Evidence};
use crate::{native_windows::image_factory::{self, Factory, Image, OriginalAuthority},
    no_follow::{self, LockedPath}, protocol::Identity};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, fs::File, io::{self, Read, Seek, SeekFrom}};

const PREFIX: &str = if cfg!(target_arch="aarch64") { "packages/work-file-helper/bin/win32-arm64/" } else { "packages/work-file-helper/bin/win32-x64/" };
const TARGET: &str = if cfg!(target_arch="aarch64") { "win32-arm64" } else { "win32-x64" };
const FILES: [&str; 3] = ["deepagent-work-file-helper.exe", "deepagent-work-process-supervisor.exe", "bun-command-runtime.exe"];
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Fingerprint { bytes: u64, sha256: String }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all="camelCase")]
struct NodePayload { components_hash: String, domain: String, executable: Fingerprint, #[serde(rename="releaseID")] release_id: String,
    #[serde(skip_serializing_if="Option::is_none")] runtime: Option<Fingerprint>, source_commit: String, source_tree: String, target: String }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt { payload: NodePayload, signature: String }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Component { bytes: u64, path: String, sha256: String }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all="camelCase")]
struct Inventory { components: Vec<Component>, schema_version: String, source_commit: String, source_tree: String, target: String }
#[derive(Serialize)]
struct Description { library_evidence: &'static str, target: &'static str, bootstrap_hash: String, closure_hash: String,
    helper: PublishedImage, supervisor: PublishedImage, payload: PublishedImage, libraries: Vec<PublishedImage> }
#[derive(Serialize)]
struct PublishedImage { asset_path: Option<String>, path: std::path::PathBuf, identity: Identity,
    bytes: u64, sha256: String, system: bool }

pub struct WorkFactory { receipt: LockedPath, inventory: LockedPath, stamps: [String; 2], helper: Image,
    factory: Factory, system_imports: Vec<loader::WorkSystemImage>, windows_root: LockedPath,
    event_git: std::sync::OnceLock<std::sync::Arc<super::event_git::Git>>, data_path: std::path::PathBuf, data_root: LockedPath, windows_environment: Vec<u16>, supervisor_environment: Vec<u16>, profiles: Vec<(String, String, LockedPath)>, description: String }
struct Original<'a> { image: &'a FirstLoad, proof: &'a Evidence, imports: RefCell<Vec<loader::WorkSystemImage>> }
impl OriginalAuthority for Original<'_> {
    fn current(&self) -> io::Result<()> { self.image.current()?; self.proof.current()?; for image in self.imports.borrow().iter(){image.current()?;} Ok(()) }
    fn system_images(&self) -> io::Result<Vec<image_factory::Description>> {
        self.current()?;
        self.image.complete_work_system_imports(&mut self.imports.borrow_mut())?;
        let mut values=self.image.original_system_images()?.into_iter().map(|(path,image)|image_factory::Description{path,identity:image.identity,bytes:image.bytes,sha256:image.sha256}).collect::<Vec<_>>();
        for imported in self.imports.borrow().iter(){let(path,image)=imported.description();if !values.iter().any(|value|value.identity==image.identity){values.push(image_factory::Description{path:path.to_owned(),identity:image.identity.clone(),bytes:image.bytes,sha256:image.sha256.clone()});}}
        Ok(values)
    }
    fn resolve_system_import(&self,name:&str)->io::Result<Identity>{
        if let Ok(identity)=self.image.resolve_system_import(name){return Ok(identity);}
        let imported=self.image.qualify_work_system_import(name)?;let identity=imported.description().1.identity.clone();
        let mut images=self.imports.borrow_mut();
        if images.len()>=128{return Err(io::ErrorKind::Unsupported.into());}
        if !images.iter().any(|image|image.description().1.identity==identity){images.push(imported);}
        Ok(identity)
    }
}
impl WorkFactory {
    pub fn open(image: &FirstLoad, proof: &Evidence) -> io::Result<Self> {
        let original = Original { image, proof, imports: RefCell::new(Vec::new()) }; original.current()?;
        let directory = image.bootstrap_path()?.parent().ok_or(io::ErrorKind::Unsupported)?;
        let artifact=proof.artifact_name()?;
        let receipt = LockedPath::open(&directory.join(format!("{artifact}.native-installation.json")), false, false)?;
        let inventory = LockedPath::open(&directory.join(format!("{artifact}.native-components.json")), false, false)?;
        loader::require_trusted(&receipt.file)?; loader::require_trusted(&inventory.file)?;
        let stamps = [no_follow::stamp(&receipt.file)?, no_follow::stamp(&inventory.file)?];
        let receipt_bytes = read(&receipt.file, 16_384)?;
        let inventory_bytes = read(&inventory.file, 1_048_576)?;
        let signed: Receipt = phase("receipt-decode",serde_json::from_slice(&receipt_bytes).map_err(io::Error::other))?;
        let components: Inventory = phase("inventory-decode",serde_json::from_slice(&inventory_bytes).map_err(io::Error::other))?;
        if canonical(&signed)? != receipt_bytes || canonical(&components)? != inventory_bytes ||
            signed.payload.domain != if artifact=="node.js"{"dac.native-node-installation.v1"}else{"dac.native-installation.v1"} || signed.payload.target != TARGET ||
            signed.payload.runtime.is_some() != (artifact=="node.js") ||
            components.schema_version != "dac.native-components.v1" || components.target != TARGET ||
            signed.payload.source_commit != components.source_commit || signed.payload.source_tree != components.source_tree ||
            components.components.is_empty() || components.components.len() > 4096 ||
            signed.payload.components_hash != format!("{:x}", Sha256::digest(&inventory_bytes)) ||
            components.components.windows(2).any(|pair| pair[0].path >= pair[1].path) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let public = option_env!("DAC_NATIVE_PRELOADER_PUBLISHER_HEX").ok_or(io::ErrorKind::Unsupported)?;
        VerifyingKey::from_bytes(&hex::<32>(public)?).map_err(io::Error::other)?
            .verify_strict(&canonical(&signed.payload)?, &Signature::from_bytes(&hex::<64>(&signed.signature)?)).map_err(io::Error::other)?;
        fingerprint(proof.node_file()?, &signed.payload.executable)?;
        fingerprint(image.original_host_file()?, signed.payload.runtime.as_ref().unwrap_or(&signed.payload.executable))?;
        let open = |name: &str| -> io::Result<image_factory::Description> {
            let wanted = format!("{PREFIX}{name}");
            let component = components.components.iter().find(|value| value.path == wanted).ok_or(io::ErrorKind::PermissionDenied)?;
            if component.bytes == 0 || component.bytes > if name == FILES[2] { 268_435_456 } else { 16_777_216 } { return Err(io::ErrorKind::InvalidData.into()); }
            let held = LockedPath::open(&directory.join(name), false, true)?; loader::require_trusted(&held.file)?;
            Ok(image_factory::Description { path: directory.join(name), identity: no_follow::identity(&held.file)?,
                sha256: component.sha256.clone(), bytes: component.bytes })
        };
        let helper = phase("helper-image",Image::open(open(FILES[0])?))?;
        for name in helper.required_imports(){original.resolve_system_import(name)?;}
        let factory = phase("command-image-closure",Factory::open_original(&original, open(FILES[1])?, open(FILES[2])?))?;
        loader::require_trusted(helper.file())?; loader::require_trusted(factory.supervisor().file())?; loader::require_trusted(factory.payload().file())?;
        let (windows_name,windows_root)=image.original_windows_root()?;
        let windows_name=windows_name.to_str().ok_or(io::ErrorKind::InvalidData)?;
        let data_path=super::work_workspace::fixed_data_root()?;
        let data_root=LockedPath::open(&data_path,true,false)?;
        loader::require_trusted(&data_root.file)?;
        let data_name=data_path.to_str().ok_or(io::ErrorKind::InvalidData)?;
        let windows_environment=format!("DEEPAGENT_WORK_DATA_ROOT={data_name}\0SYSTEMROOT={windows_name}\0WINDIR={windows_name}\0\0").encode_utf16().collect();
        // Fixed OS/profile facts are captured by this original Native owner,
        // never accepted through a recipe environment or a path descriptor.
        let profiles = ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"].into_iter().map(|name| {
            let value = std::env::var(name).map_err(|_| io::ErrorKind::Unsupported)?;
            if value.len() > 2048 || value.chars().any(char::is_control) || !std::path::Path::new(&value).is_absolute() {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let held = LockedPath::open(std::path::Path::new(&value), true, false)?;
            loader::require_trusted(&held.file)?;
            Ok((name.to_owned(), value, held))
        }).collect::<io::Result<Vec<_>>>()?;
        let mut environment = std::collections::BTreeMap::from([("DEEPAGENT_WORK_DATA_ROOT".to_owned(), data_name.to_owned()),
            ("SYSTEMROOT".to_owned(), windows_name.to_owned()), ("WINDIR".to_owned(), windows_name.to_owned())]);
        for (name, value, _) in &profiles { environment.insert(name.clone(), value.clone()); }
        let supervisor_environment = environment.iter().flat_map(|(name,value)| format!("{name}={value}\0").encode_utf16().collect::<Vec<_>>())
            .chain([0]).collect::<Vec<_>>();
        let description = serde_json::to_string(&Description { library_evidence: "original-system32-import-leases.v1", target: TARGET,
            bootstrap_hash: image.description().bootstrap.sha256.clone(), closure_hash: factory.closure_hash().to_owned(),
            helper: published(&helper, Some(FILES[0]), false), supervisor: published(factory.supervisor(), Some(FILES[1]), false),
            payload: published(factory.payload(), Some(FILES[2]), false),
            libraries: factory.libraries().iter().map(|image| published(image, None, true)).collect() })?;
        let result = Self { receipt, inventory, stamps, helper, factory, system_imports: original.imports.into_inner(),
            windows_root, event_git: std::sync::OnceLock::new(), data_path, data_root, windows_environment, supervisor_environment, profiles, description };
        result.current(image,proof)?; Ok(result)
    }
    pub fn current(&self, image: &FirstLoad, proof: &Evidence) -> io::Result<()> {
        image.current()?; proof.current()?; self.windows_root.current()?; loader::require_machine(&self.windows_root.file)?;
        self.data_root.current()?;loader::require_trusted(&self.data_root.file)?;
        if super::work_workspace::fixed_data_root()?!=self.data_path{return Err(io::ErrorKind::PermissionDenied.into());}
        for (name, value, held) in &self.profiles {
            if std::env::var(name).ok().as_ref() != Some(value) { return Err(io::ErrorKind::PermissionDenied.into()); }
            held.current()?; loader::require_trusted(&held.file)?;
        }
        for (file, stamp) in [&self.receipt,&self.inventory].iter().zip(&self.stamps) {
            file.current()?; loader::require_trusted(&file.file)?;
            if no_follow::stamp(&file.file)? != *stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
        }
        self.helper.current()?; self.factory.current()?;
        for imported in &self.system_imports{imported.current()?;}
        for file in [self.helper.file(),self.factory.supervisor().file(),self.factory.payload().file()] { loader::require_trusted(file)?; }
        Ok(())
    }
    pub fn describe(&self, image: &FirstLoad, proof: &Evidence) -> io::Result<&str> { self.current(image,proof)?; Ok(&self.description) }
    pub(super) fn event_git(&self,image:&FirstLoad,proof:&Evidence)->io::Result<std::sync::Arc<super::event_git::Git>> {
        self.current(image,proof)?;
        if self.event_git.get().is_none() {
            let value=std::sync::Arc::new(super::event_git::Git::open(image,proof,self)?);
            let _=self.event_git.set(value);
        }
        let value=self.event_git.get().ok_or(io::ErrorKind::Other)?.clone();value.current()?;Ok(value)
    }
    pub(super) fn data_path(&self)->&std::path::Path { &self.data_path }
    pub(crate) fn windows_environment(&self) -> &[u16] { &self.windows_environment }
    pub(crate) fn supervisor_environment(&self) -> &[u16] { &self.supervisor_environment }
    pub(crate) fn helper(&self) -> &Image { &self.helper }
    pub(crate) fn factory(&self) -> &Factory { &self.factory }
}
fn published(image: &Image, name: Option<&str>, system: bool) -> PublishedImage {
    let value = image.description();
    PublishedImage { asset_path: name.map(|name| format!("{PREFIX}{name}")), path: value.path.clone(), identity: value.identity.clone(),
        bytes: value.bytes, sha256: value.sha256.clone(), system }
}
fn read(file: &File, limit: u64) -> io::Result<Vec<u8>> {
    let stamp = no_follow::stamp(file)?; let size = file.metadata()?.len();
    if size == 0 || size > limit { return Err(io::ErrorKind::InvalidData.into()); }
    let mut reader = file.try_clone()?; reader.seek(SeekFrom::Start(0))?;
    let mut body = Vec::new(); reader.take(size+1).read_to_end(&mut body)?;
    if body.len() as u64 != size || no_follow::stamp(file)? != stamp { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(body)
}
fn fingerprint(file: &File, expected: &Fingerprint) -> io::Result<()> {
    if expected.bytes == 0 || expected.bytes > 268_435_456 || hex::<32>(&expected.sha256).is_err() { return Err(io::ErrorKind::InvalidData.into()); }
    let body = read(file,expected.bytes)?;
    if body.len() as u64 != expected.bytes || format!("{:x}", Sha256::digest(body)) != expected.sha256 { return Err(io::ErrorKind::PermissionDenied.into()); }
    Ok(())
}
fn canonical(value: &impl Serialize) -> io::Result<Vec<u8>> {
    serde_json::to_vec(&serde_json::to_value(value).map_err(io::Error::other)?).map_err(io::Error::other)
}
fn hex<const SIZE: usize>(value: &str) -> io::Result<[u8; SIZE]> {
    if value.len() != SIZE*2 || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) { return Err(io::ErrorKind::InvalidData.into()); }
    let mut bytes = [0u8; SIZE];
    for (index, byte) in bytes.iter_mut().enumerate() { *byte = u8::from_str_radix(&value[index*2..index*2+2],16).map_err(io::Error::other)?; }
    Ok(bytes)
}

fn phase<A>(stage: &'static str,value: io::Result<A>)->io::Result<A>{value.inspect_err(|error|eprintln!("WINDOWS_WORK_FACTORY_FAILURE phase={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0)))}
