//! Original fixed-data command workspace custody. JSON names select only within
//! the process-captured DAC data root; they do not create a Work or cleanup permit.
use crate::{no_follow::{self,LockedPath},private_directory::{self,Descriptor},protocol::Identity};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{collections::{BTreeMap,BTreeSet},ffi::{c_void,OsStr},fs::File,io::{self,Read,Seek,SeekFrom},mem::{offset_of,size_of,MaybeUninit},
    os::windows::{ffi::OsStrExt,io::{AsRawHandle,FromRawHandle,OwnedHandle,RawHandle}},path::{Path,PathBuf},ptr,sync::{Arc,OnceLock}};
use windows_sys::Win32::{Foundation::{LocalFree,HANDLE,INVALID_HANDLE_VALUE,NTSTATUS,RtlNtStatusToDosError,UNICODE_STRING},
    Security::{DACL_SECURITY_INFORMATION,OWNER_SECURITY_INFORMATION,GetSecurityDescriptorLength,EqualSid,GetTokenInformation,TOKEN_QUERY,TOKEN_USER,TokenUser,Authorization::{GetSecurityInfo,SE_FILE_OBJECT}},
    Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL,FILE_GENERIC_READ,FILE_SHARE_READ,FILE_ID_BOTH_DIR_INFO,
        FILE_STANDARD_INFO,FileStandardInfo,FileIdBothDirectoryInfo,FileIdBothDirectoryRestartInfo,FILE_DISPOSITION_INFO,FileDispositionInfo,
        GetFileInformationByHandleEx,SetFileInformationByHandle},System::{Threading::{GetCurrentProcess,OpenProcessToken},IO::{IO_STATUS_BLOCK,IO_STATUS_BLOCK_0},Kernel::{OBJ_CASE_INSENSITIVE,OBJ_DONT_REPARSE}}};
const MAX_FILE:u64=16_777_216;
const MAX_INPUT_BYTES:u64=67_108_864;
const MAX_BYTES:u64=100_663_296;
const MAX_FILES:usize=288;
const MAX_DIRS:usize=4610;
static DATA_ROOT:OnceLock<PathBuf>=OnceLock::new();
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Open {pub root:String,pub basename:String,pub project:String}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadOutput {pub relative:String,pub limit:u64}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Expected {pub relative:String,pub bytes:u64,pub sha256:String}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Cleanup {pub expected:Vec<Expected>,pub directories:Vec<String>}
#[derive(Serialize,Clone)]
pub(crate) struct FileFact {pub relative:String,pub identity:Identity,pub bytes:u64,pub sha256:String,pub stamp:String}
#[derive(Serialize,Clone)]
pub(crate) struct DirectoryFact {pub relative:String,pub identity:Identity,pub stamp:String}
#[derive(Serialize)]
pub(crate) struct Inventory {pub data_identity:Identity,pub stage_identity:Identity,pub project_identity:Identity,pub root_identity:Identity,
    pub files:Vec<FileFact>,pub directories:Vec<DirectoryFact>}
pub(super) struct Members {pub files:BTreeMap<String,(File,FileFact)>,pub directories:BTreeMap<String,(File,DirectoryFact)>}
#[derive(Clone,Copy,PartialEq,Eq)]
pub(crate) enum WorkspacePhaseState {Ready,Running,Retired,Unknown}
/// Only the original Native child/security owner can supply this port. Host
/// metadata cannot turn a SID or an observed ACL into an execution authority.
pub(crate) trait WorkspacePhase:Send+Sync {
    fn state(&self)->WorkspacePhaseState;
    fn validate(&self,file:&File,relative:&str)->io::Result<()>;
}
pub(super) struct Workspace {pub data:LockedPath,pub stage:LockedPath,pub project:LockedPath,pub root:Option<LockedPath>,pub directory:PathBuf,pub basename:String,
    pub identity:Identity,cleaned:bool,unknown:bool,phase:Option<Arc<dyn WorkspacePhase>>}
impl Workspace {
    /// Opens existing storage for an independently authenticated known collector.
    /// The caller never registers this value in the execution-workspace bridge.
    pub(super) fn open_known(request: Open, data_identity: &Identity, stage_identity: &Identity,
        project_identity: &Identity, root_identity: &Identity) -> io::Result<Self> {
        let selected = request.basename.clone();
        Self::open_known_at(request, &selected, data_identity, stage_identity, project_identity, root_identity)
    }

    pub(super) fn open_known_at(request: Open, selected: &str, data_identity: &Identity, stage_identity: &Identity,
        project_identity: &Identity, root_identity: &Identity) -> io::Result<Self> {
        if selected != request.basename && (selected.len() != 40 || !selected.starts_with("cleanup_") ||
            !selected[8..].bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let expected = fixed_data_root()?;
        if Path::new(&request.root) != expected || request.basename.len() != 36 ||
            !request.basename.starts_with("cmd_") || !request.basename[4..].bytes().all(|value|
                value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let data = LockedPath::open(&expected, true, false)?;
        require_owner(&data.file)?;
        let project = LockedPath::open(Path::new(&request.project), true, false)?;
        let stage_path = expected.join("work-command-stage");
        let stage = LockedPath::open(&stage_path, true, false)?;
        private_directory::require_private(&stage.file)?;
        if no_follow::identity(&data.file)? != *data_identity || no_follow::identity(&stage.file)? != *stage_identity ||
            no_follow::identity(&project.file)? != *project_identity ||
            overlaps(&stage.canonical().join(selected), project.canonical()) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let directory = stage_path.join(selected);
        let root = LockedPath::open(&directory, true, false)?;
        private_directory::require_private(&root.file)?;
        if no_follow::identity(&root.file)? != *root_identity { return Err(io::ErrorKind::PermissionDenied.into()); }
        let value = Self { data, stage, project, root: Some(root), directory, basename: selected.to_owned(),
            identity: root_identity.clone(), cleaned: false, unknown: false, phase: None };
        value.current()?;
        Ok(value)
    }

    pub(super) fn known_inventory(&self) -> io::Result<Inventory> {
        self.current()?;
        let members = self.members(false, MAX_BYTES)?;
        self.require_members(&members)?;
        Ok(Inventory { data_identity: no_follow::identity(&self.data.file)?, stage_identity: no_follow::identity(&self.stage.file)?,
            project_identity: no_follow::identity(&self.project.file)?, root_identity: self.identity.clone(),
            files: members.files.into_values().map(|(_, fact)| fact).collect(),
            directories: members.directories.into_values().map(|(_, fact)| fact).collect() })
    }

    pub(super) fn known_descriptors(&self) -> io::Result<Vec<(String, Identity, Vec<u8>)>> {
        self.current()?;
        let members = self.members(false, MAX_BYTES)?;
        self.require_members(&members)?;
        let mut facts = Vec::with_capacity(members.files.len() + members.directories.len());
        // Preserve the original Phase hash order: files then directories, each sorted.
        for (relative, (file, fact)) in &members.files {
            facts.push((relative.clone(), fact.identity.clone(), original_descriptor(file)?));
        }
        for (relative, (file, fact)) in &members.directories {
            facts.push((relative.clone(), fact.identity.clone(), original_descriptor(file)?));
        }
        self.require_members(&members)?;
        Ok(facts)
    }

    pub(super) fn open(request:Open)->io::Result<Self>{
        let expected=fixed_data_root()?;
        if Path::new(&request.root)!=expected||request.basename.len()!=36||!request.basename.starts_with("cmd_")||
            !request.basename[4..].bytes().all(|value|value.is_ascii_digit()||(b'a'..=b'f').contains(&value)){
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let data=LockedPath::open(&expected,true,false)?;require_owner(&data.file)?;
        let project=LockedPath::open(Path::new(&request.project),true,false)?;
        let stage_path=expected.join("work-command-stage");
        let stage=match LockedPath::open(&stage_path,true,false){
            Ok(stage)=>stage,
            Err(error)if error.kind()==io::ErrorKind::NotFound=>{
                let descriptor=Descriptor::current_user()?;
                let created=no_follow::create_private_child(&data.file,"work-command-stage",true,descriptor.pointer())?;
                let identity=no_follow::identity(&created)?;private_directory::require_private(&created)?;drop(created);
                let stage=LockedPath::open(&stage_path,true,false)?;
                if no_follow::identity(&stage.file)?!=identity{return Err(io::ErrorKind::PermissionDenied.into());}stage
            },Err(error)=>return Err(error),
        };
        data.current()?;stage.current()?;private_directory::require_private(&stage.file)?;
        let directory=stage_path.join(&request.basename);
        let physical_directory=stage.canonical().join(&request.basename);
        if overlaps(&physical_directory,project.canonical()){return Err(io::ErrorKind::PermissionDenied.into());}
        let descriptor=Descriptor::current_user()?;
        let created=no_follow::create_private_child(&stage.file,&request.basename,true,descriptor.pointer())?;
        let identity=no_follow::identity(&created)?;private_directory::require_private(&created)?;drop(created);
        let root=LockedPath::open(&directory,true,false)?;
        if no_follow::identity(&root.file)?!=identity||!names(&open_child(&stage.file,&request.basename,true,false)?)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
        let value=Self{data,stage,project,root:Some(root),directory,basename:request.basename,identity,cleaned:false,unknown:false,phase:None};value.current()?;Ok(value)
    }
    pub(crate) fn attach_phase(&mut self,phase:Arc<dyn WorkspacePhase>,expected_original_root_identity:&Identity)->io::Result<()>{
        if self.phase.is_some()||expected_original_root_identity!=&self.identity||phase.state()!=WorkspacePhaseState::Ready{
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.current()?;
        let root=self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        private_directory::require_private(&root.file)?;phase.validate(&root.file,"")?;
        if phase.state()!=WorkspacePhaseState::Ready{return Err(io::ErrorKind::PermissionDenied.into());}
        self.phase=Some(phase);Ok(())
    }
    fn validate_file(&self,file:&File,relative:&str)->io::Result<()>{
        require_owner(file)?;
        let Some(phase)=&self.phase else{return private_directory::require_private(file);};
        let state=phase.state();
        if state!=WorkspacePhaseState::Ready&&state!=WorkspacePhaseState::Retired{return Err(io::ErrorKind::PermissionDenied.into());}
        phase.validate(file,relative)?;
        if state==WorkspacePhaseState::Retired{private_directory::require_private(file)?;}
        if phase.state()!=state{return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
    }
    fn require_retired(&self)->io::Result<()>{
        if self.phase.as_ref().is_some_and(|phase|phase.state()!=WorkspacePhaseState::Retired){return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
    }
    pub(super) fn description(&self)->io::Result<String>{
        self.current()?;serde_json::to_string(&serde_json::json!({"version":1,"directory":self.directory,"identity":self.identity})).map_err(io::Error::other)
    }
    pub(super) fn current(&self)->io::Result<()>{
        if self.cleaned||self.unknown||fixed_data_root()?!=self.data_path(){return Err(io::ErrorKind::PermissionDenied.into());}
        self.data.current()?;require_owner(&self.data.file)?;self.stage.current()?;private_directory::require_private(&self.stage.file)?;self.project.current()?;
        let root=self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;root.current()?;self.validate_file(&root.file,"")?;
        if no_follow::identity(&root.file)?!=self.identity{return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
    }
    /// Native-only pre-grant descriptor facts. All temporary member handles are
    /// closed before returning; these bytes are observations, never an ACL permit.
    pub(super) fn command_descriptors(&self)->io::Result<Vec<(String,Identity,Vec<u8>)>>{
        if self.phase.is_some(){return Err(io::ErrorKind::PermissionDenied.into());}
        self.current()?;let members=self.members(false,MAX_INPUT_BYTES)?;self.require_members(&members)?;
        let mut facts=Vec::with_capacity(members.files.len()+members.directories.len());
        for(relative,(file,fact))in &members.files{
            facts.push((relative.clone(),fact.identity.clone(),original_descriptor(file)?));
        }
        for(relative,(file,fact))in &members.directories{
            facts.push((relative.clone(),fact.identity.clone(),original_descriptor(file)?));
        }
        self.require_members(&members)?;Ok(facts)
    }
    pub(super) fn command_location(&self)->io::Result<(PathBuf,Identity)>{
        self.current()?;Ok((self.directory.clone(),self.identity.clone()))
    }
    fn data_path(&self)->PathBuf{self.directory.parent().and_then(Path::parent).unwrap_or(Path::new("")).to_owned()}
    pub(super) fn read_output(&self,request:ReadOutput)->io::Result<(String,Vec<u8>)>{
        self.current()?;if request.limit>MAX_FILE{return Err(io::ErrorKind::InvalidInput.into());}
        let root=self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        let parts=member(&request.relative)?;
        let mut file=no_follow::open_relative(&root.file,&parts)?;
        self.validate_file(&file,&request.relative)?;named(&file,root.canonical(),&request.relative)?;
        let stamp=no_follow::stamp(&file)?;let identity=no_follow::identity(&file)?;let size=file.metadata()?.len();
        if size>request.limit{return Err(io::ErrorKind::InvalidData.into());}
        file.seek(SeekFrom::Start(0))?;let mut bytes=Vec::with_capacity(size as usize);Read::by_ref(&mut file).take(size+1).read_to_end(&mut bytes)?;
        self.current()?;self.validate_file(&file,&request.relative)?;named(&file,root.canonical(),&request.relative)?;
        if bytes.len()as u64!=size||no_follow::stamp(&file)?!=stamp{return Err(io::ErrorKind::PermissionDenied.into());}
        let metadata=serde_json::to_string(&serde_json::json!({"version":1,"relative":request.relative,"identity":identity,"bytes":size,
            "sha256":format!("{:x}",Sha256::digest(&bytes)),"snapshot":"stream_observation"}))?;Ok((metadata,bytes))
    }
    /// Native-only complete original inventory. Its object is produced by held-FD
    /// traversal, never decoded from a Host JSON permission claim.
    pub(crate) fn observe_inventory(&self)->io::Result<Inventory>{
        self.current()?;let members=self.members(false,MAX_INPUT_BYTES)?;self.require_members(&members)?;
        Ok(Inventory{data_identity:no_follow::identity(&self.data.file)?,stage_identity:no_follow::identity(&self.stage.file)?,
            project_identity:no_follow::identity(&self.project.file)?,root_identity:self.identity.clone(),
            files:members.files.into_values().map(|(_,fact)|fact).collect(),directories:members.directories.into_values()
                .map(|(_,fact)|fact).collect()})
    }
    pub(super) fn cleanup(&mut self,request:Cleanup)->io::Result<String>{
        self.current()?;self.require_retired()?;validate_cleanup(&request)?;
        let mut members=self.members(true,MAX_BYTES)?;
        if members.files.len()!=request.expected.len()||members.directories.len()!=request.directories.len()+1||
            request.expected.iter().any(|expected|members.files.get(&expected.relative).is_none_or(|(_,actual)|actual.bytes!=expected.bytes||actual.sha256!=expected.sha256))||
            request.directories.iter().any(|name|!members.directories.contains_key(name)){
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.require_members(&members)?;
        // Inventory and every exact named FileID/hash are verified before the
        // first mutation. From here any failure is retained unknown, never retried.
        self.unknown=true;
        let result=(||->io::Result<()>{
            let root=self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
            for(relative,(file,fact))in &members.files{
                self.require_retired()?;named(file,root.canonical(),relative)?;self.validate_file(file,relative)?;
                if no_follow::stamp(file)?!=fact.stamp{return Err(io::ErrorKind::PermissionDenied.into());}
                remove(file)?;
            }
            members.files.clear();
            let mut directories=members.directories.keys().filter(|name|!name.is_empty()).cloned().collect::<Vec<_>>();
            directories.sort_by_key(|name|std::cmp::Reverse(name.split('/').count()));
            for relative in directories{
                let(file,fact)=members.directories.remove(&relative).ok_or(io::ErrorKind::InvalidData)?;
                self.require_retired()?;named(&file,root.canonical(),&relative)?;self.validate_file(&file,&relative)?;
                if no_follow::identity(&file)?!=fact.identity||!names(&file)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
                remove(&file)?;drop(file);
            }
            if !names(&members.directories.get("").ok_or(io::ErrorKind::InvalidData)?.0)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
            let stamp=no_follow::stamp(&root.file)?;let canonical=root.canonical().to_owned();
            members.directories.clear();drop(self.root.take());
            let held=open_child(&self.stage.file,&self.basename,true,true)?;
            self.require_retired()?;self.validate_file(&held,"")?;
            if no_follow::identity(&held)?!=self.identity||no_follow::stamp(&held)?!=stamp||no_follow::final_path(&held)?!=canonical||!names(&held)?.is_empty(){
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            remove(&held)?;drop(held);self.stage.current()?;
            match open_child(&self.stage.file,&self.basename,true,false){Err(error)if error.kind()==io::ErrorKind::NotFound=>Ok(()),_=>Err(io::ErrorKind::PermissionDenied.into())}
        })();
        result?;self.cleaned=true;self.unknown=false;
        serde_json::to_string(&serde_json::json!({"version":1,"state":"cleaned","identity":self.identity})).map_err(io::Error::other)
    }
    pub(super) fn members(&self,delete:bool,limit:u64)->io::Result<Members>{
        let root=self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        let reader=open_child(&self.stage.file,&self.basename,true,false)?;
        if no_follow::identity(&reader)?!=self.identity||no_follow::final_path(&reader)?!=root.canonical(){return Err(io::ErrorKind::PermissionDenied.into());}
        let identity=no_follow::identity(&reader)?;let stamp=no_follow::stamp(&reader)?;
        let mut result=Members{files:BTreeMap::new(),directories:BTreeMap::from([(String::new(),(reader,DirectoryFact{relative:String::new(),identity,stamp}))])};
        let mut pending=vec![String::new()];let mut total=0u64;
        while let Some(relative)=pending.pop(){
            let parent=result.directories.get(&relative).ok_or(io::ErrorKind::InvalidData)?.0.try_clone()?;
            let stamp=no_follow::stamp(&parent)?;
            let entries=names(&parent)?;
            for(name,directory)in entries{
                let selected=if relative.is_empty(){name.clone()}else{format!("{relative}/{name}")};let parts=member(&selected)?;
                if parts.len()>16{return Err(io::ErrorKind::InvalidData.into());}
                let file=open_child(&parent,&name,directory,delete)?;self.validate_file(&file,&selected)?;named(&file,root.canonical(),&selected)?;
                let identity=no_follow::identity(&file)?;let observed=no_follow::stamp(&file)?;
                if directory{
                    if result.directories.len()>MAX_DIRS{return Err(io::ErrorKind::InvalidData.into());}
                    pending.push(selected.clone());result.directories.insert(selected.clone(),(file,DirectoryFact{relative:selected,identity,stamp:observed}));
                }else{
                    if result.files.len()>=MAX_FILES||!crate::regular_file::is_disk_file(&file){return Err(io::ErrorKind::InvalidData.into());}
                    let size=file.metadata()?.len();total=total.checked_add(size).filter(|total|*total<=limit).ok_or(io::ErrorKind::InvalidData)?;
                    if size>MAX_FILE{return Err(io::ErrorKind::InvalidData.into());}
                    let mut reader=file.try_clone()?;reader.seek(SeekFrom::Start(0))?;let mut digest=Sha256::new();
                    let mut buffer=[0u8;65536];let mut actual=0u64;loop{let count=reader.read(&mut buffer)?;if count==0{break;}actual=actual.checked_add(count as u64).filter(|actual|*actual<=size).ok_or(io::ErrorKind::InvalidData)?;digest.update(&buffer[..count]);}
                    if actual!=size||no_follow::stamp(&file)?!=observed{return Err(io::ErrorKind::PermissionDenied.into());}
                    result.files.insert(selected.clone(),(file,FileFact{relative:selected,identity,bytes:size,sha256:format!("{:x}",digest.finalize()),stamp:observed}));
                }
            }
            if no_follow::stamp(&result.directories.get(&relative).ok_or(io::ErrorKind::InvalidData)?.0)?!=stamp{return Err(io::ErrorKind::PermissionDenied.into());}
        }Ok(result)
    }
    pub(super) fn require_members(&self,members:&Members)->io::Result<()>{
        self.current()?;let root=self.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        for(relative,(file,fact))in &members.files{
            self.validate_file(file,relative)?;named(file,root.canonical(),relative)?;
            if no_follow::stamp(file)?!=fact.stamp{return Err(io::ErrorKind::PermissionDenied.into());}
        }
        for(relative,(file,fact))in &members.directories{
            self.validate_file(file,relative)?;
            if !relative.is_empty(){named(file,root.canonical(),relative)?;}
            if no_follow::stamp(file)?!=fact.stamp{return Err(io::ErrorKind::PermissionDenied.into());}
            let actual=names(file)?.into_iter().map(|(name,_)|if relative.is_empty(){name}else{format!("{relative}/{name}")}).collect::<BTreeSet<_>>();
            let expected=members.files.keys().chain(members.directories.keys()).filter(|name|!name.is_empty()&&name.rsplit_once('/').map_or("",|(parent,_)|parent)==relative)
                .cloned().collect::<BTreeSet<_>>();
            if actual!=expected{return Err(io::ErrorKind::PermissionDenied.into());}
        }Ok(())
    }
}
pub(super) fn fixed_data_root()->io::Result<PathBuf>{
    let value=if let Some(home)=std::env::var_os("DEEPAGENT_CODE_TEST_HOME"){
        std::env::var_os("DEEPAGENT_CODE_HOME").map(PathBuf::from).unwrap_or_else(||PathBuf::from(home).join(".deepagent").join("code"))
    }else{std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(||std::env::var_os("USERPROFILE").map(|home|PathBuf::from(home).join("AppData").join("Local")))
        .ok_or(io::ErrorKind::PermissionDenied)?.join("deepagent-code")};
    if !value.is_absolute(){return Err(io::ErrorKind::InvalidInput.into());}
    let captured=DATA_ROOT.get_or_init(||value.clone());if captured!=&value{return Err(io::ErrorKind::PermissionDenied.into());}Ok(value)
}
fn original_descriptor(file:&File)->io::Result<Vec<u8>>{
    private_directory::require_private(file)?;let stamp=no_follow::stamp(file)?;
    let mut descriptor=ptr::null_mut();
    let status=unsafe{GetSecurityInfo(file.as_raw_handle()as HANDLE,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
        ptr::null_mut(),ptr::null_mut(),ptr::null_mut(),ptr::null_mut(),&mut descriptor)};
    if status!=0||descriptor.is_null(){
        if !descriptor.is_null(){unsafe{LocalFree(descriptor);}}return Err(io::ErrorKind::PermissionDenied.into());
    }
    let length=unsafe{GetSecurityDescriptorLength(descriptor)}as usize;
    let bytes=if !(20..=65536).contains(&length){Err(io::ErrorKind::InvalidData.into())}
        else{Ok(unsafe{std::slice::from_raw_parts(descriptor.cast::<u8>(),length)}.to_vec())};
    unsafe{LocalFree(descriptor);}
    private_directory::require_private(file)?;
    if no_follow::stamp(file)?!=stamp{return Err(io::ErrorKind::PermissionDenied.into());}bytes
}
fn overlaps(left:&Path,right:&Path)->bool{let left=left.to_string_lossy().to_uppercase();let right=right.to_string_lossy().to_uppercase();left==right||left.starts_with(&(right.clone()+"\\"))||right.starts_with(&(left+"\\"))}
pub(super) fn member(relative:&str)->io::Result<Vec<&str>>{let parts=no_follow::relative(relative)?;if parts.len()>16{return Err(io::ErrorKind::InvalidInput.into());}Ok(parts)}
pub(super) fn named(file:&File,root:&Path,relative:&str)->io::Result<()>{
    if no_follow::final_path(file)?.to_string_lossy().to_uppercase()!=root.join(relative.replace('/',"\\")).to_string_lossy().to_uppercase(){return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
}
fn validate_cleanup(request:&Cleanup)->io::Result<()>{
    if request.expected.len()>MAX_FILES||request.directories.len()>MAX_DIRS{return Err(io::ErrorKind::InvalidInput.into());}
    let mut names=BTreeSet::new();let mut total=0u64;
    for entry in &request.expected{
        member(&entry.relative)?;let name=entry.relative.to_uppercase();
        if !names.insert(name)||entry.bytes>MAX_FILE||entry.sha256.len()!=64||!entry.sha256.bytes().all(|value|value.is_ascii_digit()||(b'a'..=b'f').contains(&value)){return Err(io::ErrorKind::InvalidInput.into());}
        total=total.checked_add(entry.bytes).filter(|total|*total<=MAX_BYTES).ok_or(io::ErrorKind::InvalidInput)?;
    }
    for directory in &request.directories{member(directory)?;if !names.insert(directory.to_uppercase()){return Err(io::ErrorKind::InvalidInput.into());}}
    if request.expected.iter().any(|entry|names.iter().any(|other|other.starts_with(&(entry.relative.to_uppercase()+"/")))){return Err(io::ErrorKind::InvalidInput.into());}Ok(())
}
#[repr(C)]struct ObjectAttributes{length:u32,root_directory:HANDLE,object_name:*const UNICODE_STRING,attributes:u32,security_descriptor:*const c_void,security_quality_of_service:*const c_void}
#[link(name="ntdll")]unsafe extern "system"{fn NtCreateFile(handle:*mut HANDLE,access:u32,attributes:*const ObjectAttributes,status:*mut IO_STATUS_BLOCK,allocation:*const i64,
    flags:u32,share:u32,disposition:u32,options:u32,ea:*const c_void,ea_length:u32)->NTSTATUS;}
pub(super) fn open_child(parent:&File,name:&str,directory:bool,delete:bool)->io::Result<File>{
    if member(name)?.len()!=1{return Err(io::ErrorKind::InvalidInput.into());}
    let mut text=OsStr::new(name).encode_wide().collect::<Vec<_>>();let length=u16::try_from(text.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
    let name=UNICODE_STRING{Length:length,MaximumLength:length,Buffer:text.as_mut_ptr()};let attributes=ObjectAttributes{length:size_of::<ObjectAttributes>()as u32,
        root_directory:parent.as_raw_handle()as HANDLE,object_name:&name,attributes:OBJ_CASE_INSENSITIVE as u32|OBJ_DONT_REPARSE as u32,security_descriptor:ptr::null(),security_quality_of_service:ptr::null()};
    let mut status=IO_STATUS_BLOCK{Anonymous:IO_STATUS_BLOCK_0{Status:0},Information:0};let mut handle=0;
    let code=unsafe{NtCreateFile(&mut handle,FILE_GENERIC_READ|0x0012_0000|if delete{0x0001_0000}else{0},&attributes,&mut status,ptr::null(),FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_READ,1,(if directory{1}else{0x40})|0x20,ptr::null(),0)};
    if code<0{return Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(code)}as i32));}
    if handle==0||handle==INVALID_HANDLE_VALUE{return Err(io::ErrorKind::InvalidData.into());}
    let file=File::from(unsafe{OwnedHandle::from_raw_handle(handle as RawHandle)});
    if file.metadata()?.is_dir()!=directory||!directory&&standard(&file)?.NumberOfLinks!=1{return Err(io::ErrorKind::PermissionDenied.into());}Ok(file)
}
fn standard(file:&File)->io::Result<FILE_STANDARD_INFO>{let mut value=MaybeUninit::<FILE_STANDARD_INFO>::uninit();if unsafe{GetFileInformationByHandleEx(file.as_raw_handle()as HANDLE,FileStandardInfo,value.as_mut_ptr().cast(),size_of::<FILE_STANDARD_INFO>()as u32)}==0{return Err(io::Error::last_os_error());}Ok(unsafe{value.assume_init()})}
pub(super) fn remove(file:&File)->io::Result<()>{let mut info=FILE_DISPOSITION_INFO{DeleteFile:1};if unsafe{SetFileInformationByHandle(file.as_raw_handle()as HANDLE,FileDispositionInfo,(&raw mut info).cast(),size_of::<FILE_DISPOSITION_INFO>()as u32)}==0{return Err(io::Error::last_os_error());}if standard(file)?.DeletePending==0{return Err(io::ErrorKind::PermissionDenied.into());}Ok(())}
pub(super) fn names(file:&File)->io::Result<Vec<(String,bool)>>{
    let mut buffer=vec![0usize;8192];let bytes=buffer.len()*size_of::<usize>();let mut result=Vec::new();let mut restart=true;
    loop{
        if unsafe{GetFileInformationByHandleEx(file.as_raw_handle()as HANDLE,if restart{FileIdBothDirectoryRestartInfo}else{FileIdBothDirectoryInfo},buffer.as_mut_ptr().cast(),bytes as u32)}==0{
            let error=io::Error::last_os_error();if error.raw_os_error()==Some(18){break;}return Err(error);
        }restart=false;let mut offset=0;
        loop{
            if offset+size_of::<FILE_ID_BOTH_DIR_INFO>()>bytes{return Err(io::ErrorKind::InvalidData.into());}
            let record=unsafe{&*buffer.as_ptr().cast::<u8>().add(offset).cast::<FILE_ID_BOTH_DIR_INFO>()};let count=record.FileNameLength as usize;
            if count==0||count%2!=0||count>510||offset+offset_of!(FILE_ID_BOTH_DIR_INFO,FileName)+count>bytes{return Err(io::ErrorKind::InvalidData.into());}
            let name=String::from_utf16(unsafe{std::slice::from_raw_parts((&raw const record.FileName).cast::<u16>(),count/2)}).map_err(|_|io::ErrorKind::InvalidData)?;
            if name!="."&&name!=".."{if member(&name)?.len()!=1||record.FileAttributes&0x400!=0||result.len()>=MAX_FILES+MAX_DIRS{return Err(io::ErrorKind::InvalidData.into());}result.push((name,record.FileAttributes&0x10!=0));}
            if record.NextEntryOffset==0{break;}let next=record.NextEntryOffset as usize;
            if next<offset_of!(FILE_ID_BOTH_DIR_INFO,FileName)||next%8!=0||offset+next>=bytes{return Err(io::ErrorKind::InvalidData.into());}offset+=next;
        }
    }
    let folded=result.iter().map(|(name,_)|name.to_uppercase()).collect::<BTreeSet<_>>();if folded.len()!=result.len(){return Err(io::ErrorKind::PermissionDenied.into());}Ok(result)
}
pub(super) fn require_owner(file:&File)->io::Result<()>{
    use windows_sys::Win32::Foundation::{CloseHandle,LocalFree};
    let mut token=0;if unsafe{OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&mut token)}==0{return Err(io::Error::last_os_error());}
    let result=(||->io::Result<()>{let mut size=0;unsafe{GetTokenInformation(token,TokenUser,ptr::null_mut(),0,&mut size);}
        if size==0||size>65_536{return Err(io::ErrorKind::InvalidData.into());}let mut user=vec![0usize;(size as usize).div_ceil(size_of::<usize>())];
        if unsafe{GetTokenInformation(token,TokenUser,user.as_mut_ptr().cast(),size,&mut size)}==0{return Err(io::Error::last_os_error());}
        let mut owner=ptr::null_mut();let mut descriptor=ptr::null_mut();let code=unsafe{GetSecurityInfo(file.as_raw_handle()as HANDLE,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&mut owner,ptr::null_mut(),ptr::null_mut(),ptr::null_mut(),&mut descriptor)};
        if code!=0{return Err(io::Error::from_raw_os_error(code as i32));}let same=!owner.is_null()&&unsafe{EqualSid(owner,(*user.as_ptr().cast::<TOKEN_USER>()).User.Sid)}!=0;
        unsafe{LocalFree(descriptor);}if !same{return Err(io::ErrorKind::PermissionDenied.into());}Ok(())})();unsafe{CloseHandle(token);}result
}
