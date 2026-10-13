//! Known-only cold command storage. This object is never registered as an
//! execution Workspace and cannot construct a Phase, token, Job or StopProof.
use super::{work_command_phase,work_workspace::{self,Workspace,Open,Members}};
use crate::{no_follow::{self,LockedPath},private_directory::{self,Descriptor},protocol::Identity};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{collections::BTreeSet,ffi::{c_void,OsStr},fs::File,io::{self,Read,Write},mem::{offset_of,size_of},
    os::windows::{ffi::OsStrExt,io::{AsRawHandle,FromRawHandle,OwnedHandle,RawHandle}},path::Path,ptr};
use windows_sys::Win32::{Foundation::{HANDLE,INVALID_HANDLE_VALUE,NTSTATUS,RtlNtStatusToDosError,UNICODE_STRING},
    Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL,FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_RENAME_INFO,FILE_RENAME_INFO_0,FILE_SHARE_READ},
    System::{IO::{IO_STATUS_BLOCK,IO_STATUS_BLOCK_0},Kernel::{OBJ_CASE_INSENSITIVE,OBJ_DONT_REPARSE}}};
#[derive(Deserialize,Serialize,Clone,PartialEq)] #[serde(deny_unknown_fields)]
pub(super) struct StoredFile {pub relative:String,pub identity:Identity,pub bytes:u64,pub sha256:String}
#[derive(Deserialize,Serialize,Clone,PartialEq)] #[serde(deny_unknown_fields)]
pub(super) struct StoredDirectory {pub relative:String,pub identity:Identity}
#[derive(Deserialize,Serialize,Clone,PartialEq)] #[serde(deny_unknown_fields)]
pub(super) struct Security {pub lease_set_hash:String,pub app_container_sid:String,pub restriction_sid:String}
#[derive(Deserialize,Serialize,Clone)] #[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub version:u8,pub root:String,pub project:String,pub basename:String,
    pub data_identity:Identity,pub base_identity:Identity,pub project_identity:Identity,pub container_identity:Identity,
    pub cleanup_id:String,pub manifest_hash:String,pub plan_hash:String,pub quarantine:String,
    pub nonce:String,pub inputs:Vec<String>,pub outputs:Vec<String>,pub security:Security,
    pub files:Vec<StoredFile>,pub directories:Vec<StoredDirectory>,pub job_key:String,
}
#[derive(Deserialize,Serialize,Clone,PartialEq)] #[serde(deny_unknown_fields)]
struct Progress {version:u8,request_hash:String,step:usize,acl_restore_hash:String}
#[derive(Deserialize,Serialize)] #[serde(deny_unknown_fields)]
struct Checkpoint {value:Progress,mac:String}
pub(super) struct Collector {request:Request,key:[u8;32],data:LockedPath,base:LockedPath,project:LockedPath,
    workspace:Option<Workspace>,progress:Progress,marker:String,unknown:bool,complete:bool}
impl Drop for Collector {fn drop(&mut self){self.key.fill(0);self.request.job_key.clear();}}
impl Collector {
    pub(super) fn open(mut request:Request)->io::Result<Self>{
        validate(&request)?;let key=key(&request.job_key)?;request.job_key.clear();
        let request_hash=hash(&serde_json::to_vec(&request)?);
        let data=LockedPath::open(Path::new(&request.root),true,false)?;
        let base=LockedPath::open(&Path::new(&request.root).join("work-command-stage"),true,false)?;
        let project=LockedPath::open(Path::new(&request.project),true,false)?;
        work_workspace::require_owner(&data.file)?;private_directory::require_private(&base.file)?;
        if Path::new(&request.root)!=work_workspace::fixed_data_root()?||no_follow::identity(&data.file)?!=request.data_identity||
            no_follow::identity(&base.file)?!=request.base_identity||no_follow::identity(&project.file)?!=request.project_identity{
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let marker=format!("proof_{}.json",hash(request.cleanup_id.as_bytes()));
        let prior=read_checkpoint(&base.file,&marker,&key)?;
        if prior.as_ref().is_some_and(|value|value.request_hash!=request_hash||value.step>steps(&request).len()){
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let original=optional(&base.file,&request.basename)?;let quarantine=optional(&base.file,&request.quarantine)?;
        if original&&quarantine||original&&prior.is_some()&&!prior.as_ref().is_some_and(|value|value.step==0){
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let selected=if original{Some(request.basename.as_str())}else if quarantine{Some(request.quarantine.as_str())}else{None};
        let workspace=selected.map(|selected|Workspace::open_known_at(Open{root:request.root.clone(),basename:request.basename.clone(),
            project:request.project.clone()},selected,&request.data_identity,&request.base_identity,&request.project_identity,&request.container_identity)).transpose()?;
        let progress=if let Some(prior)=prior {prior} else {
            let workspace=workspace.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
            if !original{return Err(io::ErrorKind::PermissionDenied.into());}
            let descriptors=workspace.known_descriptors()?;
            let security=work_command_phase::inspect_known_security(&descriptors,&request.nonce,&request.inputs,&request.outputs)?;
            if security.lease_set_hash!=request.security.lease_set_hash||security.app_container_sid!=request.security.app_container_sid||
                security.restriction_sid!=request.security.restriction_sid{return Err(io::ErrorKind::PermissionDenied.into());}
            Progress{version:1,request_hash:request_hash.clone(),step:0,acl_restore_hash:security.acl_restore_hash}
        };
        let complete=progress.step==steps(&request).len();
        if workspace.is_none()&&!complete{return Err(io::ErrorKind::PermissionDenied.into());}
        let value=Self{request,key,data,base,project,workspace,progress,marker,unknown:false,complete};
        value.current()?;Ok(value)
    }
    fn anchors(&self)->io::Result<()>{
        self.data.current()?;self.base.current()?;self.project.current()?;work_workspace::require_owner(&self.data.file)?;
        private_directory::require_private(&self.base.file)?;
        if Path::new(&self.request.root)!=work_workspace::fixed_data_root()?||no_follow::identity(&self.data.file)?!=self.request.data_identity||
            no_follow::identity(&self.base.file)?!=self.request.base_identity||no_follow::identity(&self.project.file)?!=self.request.project_identity{
            return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
    }
    pub(super) fn current(&self)->io::Result<String>{
        if self.unknown{return Err(io::ErrorKind::PermissionDenied.into());}self.anchors()?;
        if let Some(workspace)=&self.workspace{
            let members=workspace.members(false,100_663_296)?;workspace.require_members(&members)?;self.require_remaining(&members)?;
        }else if !self.complete||optional(&self.base.file,&self.request.basename)?||optional(&self.base.file,&self.request.quarantine)?{
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        serde_json::to_string(&serde_json::json!({"version":1,"cleanup_id":self.request.cleanup_id,"manifest_hash":self.request.manifest_hash,
            "plan_hash":self.request.plan_hash,"container_identity":self.request.container_identity,"security":self.request.security,
            "acl_restore_hash":self.progress.acl_restore_hash,"step":self.progress.step,"complete":self.complete})).map_err(io::Error::other)
    }
    fn require_remaining(&self,members:&Members)->io::Result<()>{
        let all=steps(&self.request);let remaining=&all[self.progress.step..];
        if members.files.len()!=remaining.iter().filter(|(_,directory)|!*directory).count()||
            members.directories.len()!=remaining.iter().filter(|(_,directory)|*directory).count(){return Err(io::ErrorKind::PermissionDenied.into());}
        for file in &self.request.files{
            if !remaining.iter().any(|(relative,_)|relative==&file.relative){continue;}
            let actual=&members.files.get(&file.relative).ok_or(io::ErrorKind::PermissionDenied)?.1;
            if actual.identity!=file.identity||actual.bytes!=file.bytes||actual.sha256!=file.sha256{return Err(io::ErrorKind::PermissionDenied.into());}
        }
        for directory in &self.request.directories{
            if !remaining.iter().any(|(relative,_)|relative==&directory.relative){continue;}
            if members.directories.get(&directory.relative).ok_or(io::ErrorKind::PermissionDenied)?.1.identity!=directory.identity{
                return Err(io::ErrorKind::PermissionDenied.into());}
        }Ok(())
    }
    pub(super) fn is_unknown(&self)->bool{self.unknown}
    pub(super) fn collect(&mut self)->io::Result<String>{
        self.current()?;if self.complete{return self.current();}
        // This original held private lock serializes identical jobs across envs/processes.
        let lock_name=format!("lock_{}.json",hash(self.request.cleanup_id.as_bytes()));
        let descriptor=Descriptor::current_user()?;
        let _lock=open(&self.base.file,&lock_name,false,FILE_GENERIC_READ|FILE_GENERIC_WRITE,3,descriptor.pointer(),0)?;
        private_directory::require_private(&_lock)?;
        if let Some(prior)=read_checkpoint(&self.base.file,&self.marker,&self.key)?{
            if prior!=self.progress{return Err(io::ErrorKind::PermissionDenied.into());}
        }else{save_checkpoint(&self.base.file,&self.marker,&self.progress,&self.key)?;}
        self.unknown=true;
        let result=(||->io::Result<()>{
            let workspace=self.workspace.as_mut().ok_or(io::ErrorKind::PermissionDenied)?;
            if workspace.basename==self.request.basename{
                let root=workspace.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
                let identity=no_follow::identity(&root.file)?;let stamp=no_follow::stamp(&root.file)?;
                drop(workspace.root.take());
                let file=work_workspace::open_child(&self.base.file,&self.request.basename,true,true)?;
                if identity!=self.request.container_identity||no_follow::identity(&file)?!=identity||no_follow::stamp(&file)?!=stamp{
                    return Err(io::ErrorKind::PermissionDenied.into());}
                rename(&file,&self.base.file,&self.request.quarantine,false)?;drop(file);
                workspace.basename=self.request.quarantine.clone();workspace.directory=Path::new(&self.request.root).join("work-command-stage").join(&self.request.quarantine);
                workspace.root=Some(LockedPath::open(&workspace.directory,true,false)?);
                if no_follow::identity(&workspace.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.file)?!=identity{
                    return Err(io::ErrorKind::PermissionDenied.into());}
            }
            let all=steps(&self.request);
            let workspace=self.workspace.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
            let mut members=workspace.members(true,100_663_296)?;workspace.require_members(&members)?;self.require_remaining(&members)?;
            // Keep the original deny-WRITE member handles for the whole sweep.
            // Full content is hashed once, not once per remaining file.
            while self.progress.step<all.len(){
                self.anchors()?;
                let workspace=self.workspace.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
                let(relative,directory)=&all[self.progress.step];
                if relative.is_empty(){
                    let root=workspace.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
                    if !work_workspace::names(&members.directories.get("").ok_or(io::ErrorKind::InvalidData)?.0)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
                    let stamp=no_follow::stamp(&root.file)?;members.directories.clear();
                    let workspace=self.workspace.as_mut().ok_or(io::ErrorKind::PermissionDenied)?;drop(workspace.root.take());
                    let file=work_workspace::open_child(&self.base.file,&self.request.quarantine,true,true)?;
                    if no_follow::identity(&file)?!=self.request.container_identity||no_follow::stamp(&file)?!=stamp{return Err(io::ErrorKind::PermissionDenied.into());}
                    work_workspace::remove(&file)?;drop(file);
                    if optional(&self.base.file,&self.request.quarantine)?{return Err(io::ErrorKind::PermissionDenied.into());}
                    self.workspace=None;
                }else{
                    let(file,identity,stamp)=if *directory{let(file,fact)=members.directories.remove(relative).ok_or(io::ErrorKind::InvalidData)?;(file,fact.identity,fact.stamp)}
                        else{let(file,fact)=members.files.remove(relative).ok_or(io::ErrorKind::InvalidData)?;(file,fact.identity,fact.stamp)};
                    work_workspace::named(&file,workspace.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.canonical(),relative)?;
                    private_directory::require_private(&file)?;
                    if no_follow::identity(&file)?!=identity||(!*directory&&no_follow::stamp(&file)?!=stamp){return Err(io::ErrorKind::PermissionDenied.into());}
                    if *directory&&!work_workspace::names(&file)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
                    work_workspace::remove(&file)?;drop(file);
                    let workspace=self.workspace.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
                    let parts=work_workspace::member(relative)?;
                    let root=&workspace.root.as_ref().ok_or(io::ErrorKind::PermissionDenied)?.file;
                    let leaf=parts.last().ok_or(io::ErrorKind::InvalidInput)?;
                    let parent=if parts.len()==1{root.try_clone()?}else{members.directories.get(&parts[..parts.len()-1].join("/")).ok_or(io::ErrorKind::InvalidData)?.0.try_clone()?};
                    match work_workspace::open_child(&parent,leaf,*directory,false){Err(error)if error.kind()==io::ErrorKind::NotFound=>(),_=>return Err(io::ErrorKind::PermissionDenied.into())}
                }
                // Missing bytes are accepted on a subsequent cold invocation only
                // after this exact removal was durably authenticated. A crash in
                // the syscall/checkpoint gap retains unknown rather than guessing.
                self.progress.step+=1;save_checkpoint(&self.base.file,&self.marker,&self.progress,&self.key)?;
                #[cfg(test)]
                if TEST_STOP_AFTER.load(std::sync::atomic::Ordering::SeqCst)==self.progress.step{return Err(io::ErrorKind::Interrupted.into());}
            }
            self.anchors()?;Ok(())
        })();
        result?;self.complete=true;self.unknown=false;self.current()
    }
}
fn validate(value:&Request)->io::Result<()>{
    if value.version!=1||value.files.len()>288||value.directories.is_empty()||value.directories.len()>4610||
        !digest(&value.nonce)||!digest(&value.manifest_hash)||!digest(&value.plan_hash)||!digest(&value.job_key)||
        !digest(&value.security.lease_set_hash)||value.cleanup_id.len()>256||!value.cleanup_id.starts_with("wcleanup_")||
        value.quarantine.len()!=40||!value.quarantine.starts_with("cleanup_")||!value.quarantine[8..].bytes().all(hex){return Err(io::ErrorKind::InvalidInput.into());}
    let mut names=BTreeSet::new();let mut ids=BTreeSet::new();let mut bytes=0u64;
    for file in &value.files{
        work_workspace::member(&file.relative)?;
        bytes=bytes.checked_add(file.bytes).filter(|bytes|*bytes<=100_663_296).ok_or(io::ErrorKind::InvalidInput)?;
        if file.bytes>16_777_216||!digest(&file.sha256)||!names.insert(file.relative.to_uppercase())||
            !ids.insert(serde_json::to_string(&file.identity)?){return Err(io::ErrorKind::InvalidInput.into());}
    }
    for directory in &value.directories{
        if !directory.relative.is_empty(){work_workspace::member(&directory.relative)?;}
        if !names.insert(directory.relative.to_uppercase())||!ids.insert(serde_json::to_string(&directory.identity)?){return Err(io::ErrorKind::InvalidInput.into());}
    }
    if !value.directories.iter().any(|directory|directory.relative.is_empty()&&directory.identity==value.container_identity)||
        value.files.iter().any(|file|names.iter().any(|name|name.starts_with(&(file.relative.to_uppercase()+"/"))))||
        value.inputs.len()>256||value.outputs.len()>32||value.inputs.iter().chain(&value.outputs).any(|name|!value.files.iter().any(|file|&file.relative==name)){
        return Err(io::ErrorKind::InvalidInput.into());}Ok(())
}
fn steps(value:&Request)->Vec<(String,bool)>{
    let mut files=value.files.iter().map(|file|(file.relative.clone(),false)).collect::<Vec<_>>();files.sort();
    let mut dirs=value.directories.iter().map(|directory|(directory.relative.clone(),true)).collect::<Vec<_>>();
    dirs.sort_by(|left,right|right.0.split('/').count().cmp(&left.0.split('/').count()).then(right.0.cmp(&left.0)));
    // The root has no slash but must always be the last directory.
    dirs.sort_by_key(|(name,_)|if name.is_empty(){usize::MAX}else{0});files.extend(dirs);files
}
fn optional(base:&File,name:&str)->io::Result<bool>{match work_workspace::open_child(base,name,true,false){Ok(_)=>Ok(true),Err(error)if error.kind()==io::ErrorKind::NotFound=>Ok(false),Err(error)=>Err(error)}}
fn hex(value:u8)->bool{value.is_ascii_digit()||(b'a'..=b'f').contains(&value)}
fn digest(value:&str)->bool{value.len()==64&&value.bytes().all(hex)}
fn key(value:&str)->io::Result<[u8;32]>{if !digest(value){return Err(io::ErrorKind::InvalidInput.into());}let mut result=[0;32];for(index,part)in value.as_bytes().chunks(2).enumerate(){result[index]=u8::from_str_radix(std::str::from_utf8(part).map_err(io::Error::other)?,16).map_err(io::Error::other)?;}Ok(result)}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn mac(key:&[u8;32],value:&Progress)->io::Result<String>{let mut inner=[0x36;64];let mut outer=[0x5c;64];for index in 0..32{inner[index]^=key[index];outer[index]^=key[index];}
    let mut digest=Sha256::new();digest.update(inner);digest.update(b"dac.windows.known-command-checkpoint.v1\0");digest.update(serde_json::to_vec(value)?);
    let mut result=Sha256::new();result.update(outer);result.update(digest.finalize());inner.fill(0);outer.fill(0);Ok(format!("{:x}",result.finalize()))}
fn read_checkpoint(base:&File,name:&str,key:&[u8;32])->io::Result<Option<Progress>>{
    let mut file=match work_workspace::open_child(base,name,false,false){Ok(file)=>file,Err(error)if error.kind()==io::ErrorKind::NotFound=>return Ok(None),Err(error)=>return Err(error)};
    private_directory::require_private(&file)?;let stamp=no_follow::stamp(&file)?;
    if file.metadata()?.len()>16384{return Err(io::ErrorKind::InvalidData.into());}
    let mut bytes=Vec::new();Read::by_ref(&mut file).take(16385).read_to_end(&mut bytes)?;
    let value:Checkpoint=serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let expected=mac(key,&value.value)?;
    if !digest(&value.mac)||value.value.version!=1||value.mac.bytes().zip(expected.bytes()).fold(0u8,|sum,(left,right)|sum|(left^right))!=0||
        no_follow::stamp(&file)?!=stamp{return Err(io::ErrorKind::PermissionDenied.into());}Ok(Some(value.value))
}
fn save_checkpoint(base:&File,name:&str,value:&Progress,key:&[u8;32])->io::Result<()>{
    let prior=read_checkpoint(base,name,key)?;
    if prior.as_ref().is_some_and(|old|old.request_hash!=value.request_hash||old.acl_restore_hash!=value.acl_restore_hash||old.step>value.step||value.step>old.step+1){
        return Err(io::ErrorKind::PermissionDenied.into());}
    if prior.as_ref()==Some(value){return Ok(());}
    let temp=format!("{name}.tmp");let descriptor=Descriptor::current_user()?;
    let mut file=open(base,&temp,false,FILE_GENERIC_READ|FILE_GENERIC_WRITE|0x0001_0000,2,descriptor.pointer(),FILE_SHARE_READ)?;
    let content=serde_json::to_vec(&Checkpoint{value:value.clone(),mac:mac(key,value)?})?;file.write_all(&content)?;file.sync_all()?;
    private_directory::require_private(&file)?;rename(&file,base,name,prior.is_some())?;drop(file);
    if read_checkpoint(base,name,key)?.as_ref()!=Some(value){return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
}
#[repr(C)]struct ObjectAttributes{length:u32,root_directory:HANDLE,object_name:*const UNICODE_STRING,attributes:u32,security_descriptor:*const c_void,security_quality_of_service:*const c_void}
#[link(name="ntdll")]unsafe extern "system"{fn NtCreateFile(handle:*mut HANDLE,access:u32,attributes:*const ObjectAttributes,status:*mut IO_STATUS_BLOCK,allocation:*const i64,
    flags:u32,share:u32,disposition:u32,options:u32,ea:*const c_void,ea_length:u32)->NTSTATUS;
    fn NtSetInformationFile(handle:HANDLE,status:*mut IO_STATUS_BLOCK,info:*const c_void,length:u32,class:i32)->NTSTATUS;}
fn open(parent:&File,name:&str,directory:bool,access:u32,disposition:u32,descriptor:*const c_void,share:u32)->io::Result<File>{
    if work_workspace::member(name)?.len()!=1{return Err(io::ErrorKind::InvalidInput.into());}
    let mut text=OsStr::new(name).encode_wide().collect::<Vec<_>>();let length=u16::try_from(text.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
    let name=UNICODE_STRING{Length:length,MaximumLength:length,Buffer:text.as_mut_ptr()};let attributes=ObjectAttributes{length:size_of::<ObjectAttributes>()as u32,
        root_directory:parent.as_raw_handle()as HANDLE,object_name:&name,attributes:OBJ_CASE_INSENSITIVE as u32|OBJ_DONT_REPARSE as u32,security_descriptor:descriptor,security_quality_of_service:ptr::null()};
    let mut status=IO_STATUS_BLOCK{Anonymous:IO_STATUS_BLOCK_0{Status:0},Information:0};let mut handle=0;
    let code=unsafe{NtCreateFile(&mut handle,access|0x0010_0000,&attributes,&mut status,ptr::null(),FILE_ATTRIBUTE_NORMAL,share,disposition,(if directory{1}else{0x40})|0x20,ptr::null(),0)};
    if code<0{return Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(code)}as i32));}
    if handle==0||handle==INVALID_HANDLE_VALUE{return Err(io::ErrorKind::InvalidData.into());}
    let file=File::from(unsafe{OwnedHandle::from_raw_handle(handle as RawHandle)});private_directory::require_private(&file)?;Ok(file)
}
fn rename(file:&File,parent:&File,name:&str,replace:bool)->io::Result<()>{
    if work_workspace::member(name)?.len()!=1{return Err(io::ErrorKind::InvalidInput.into());}
    private_directory::require_private(file)?;private_directory::require_private(parent)?;
    let name=OsStr::new(name).encode_wide().collect::<Vec<_>>();let bytes=offset_of!(FILE_RENAME_INFO,FileName)+name.len()*2;
    let mut storage=vec![0usize;bytes.div_ceil(size_of::<usize>())];let info=storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe{(*info).Anonymous=FILE_RENAME_INFO_0{Flags:if replace{3}else{0}};(*info).RootDirectory=parent.as_raw_handle()as HANDLE;
        (*info).FileNameLength=(name.len()*2)as u32;ptr::copy_nonoverlapping(name.as_ptr(),(&raw mut(*info).FileName).cast::<u16>(),name.len());}
    let mut status=IO_STATUS_BLOCK{Anonymous:IO_STATUS_BLOCK_0{Status:0},Information:0};
    let code=unsafe{NtSetInformationFile(file.as_raw_handle()as HANDLE,&mut status,info.cast(),bytes as u32,65)};
    if code<0{return Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(code)}as i32));}Ok(())
}

#[cfg(test)]
static TEST_STOP_AFTER:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(usize::MAX);
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(data:&Path,project:&Path,digit:char)->Request{
        let workspace=Workspace::open(Open{root:data.to_string_lossy().into_owned(),project:project.to_string_lossy().into_owned(),
            basename:format!("cmd_{}",digit.to_string().repeat(32))}).unwrap();
        let descriptor=Descriptor::current_user().unwrap();
        for(name,content)in [("input.ts",b"original source".as_slice()),("output.txt",b"known output".as_slice())]{
            let mut file=no_follow::create_private_child(&workspace.root.as_ref().unwrap().file,name,false,descriptor.pointer()).unwrap();
            file.write_all(content).unwrap();file.sync_all().unwrap();
        }
        let inventory=workspace.known_inventory().unwrap();
        let nonce=digit.to_string().repeat(64);
        let facts=work_command_phase::inspect_known_security(&workspace.known_descriptors().unwrap(),&nonce,&["input.ts".into()],&["output.txt".into()]).unwrap();
        Request{version:1,root:data.to_string_lossy().into_owned(),project:project.to_string_lossy().into_owned(),basename:workspace.basename.clone(),
            data_identity:inventory.data_identity,base_identity:inventory.stage_identity,project_identity:inventory.project_identity,
            container_identity:inventory.root_identity,cleanup_id:format!("wcleanup_{}",digit.to_string().repeat(64)),
            manifest_hash:"a".repeat(64),plan_hash:"b".repeat(64),quarantine:format!("cleanup_{}",digit.to_string().repeat(32)),nonce,
            inputs:vec!["input.ts".into()],outputs:vec!["output.txt".into()],security:Security{lease_set_hash:facts.lease_set_hash,
                app_container_sid:facts.app_container_sid,restriction_sid:facts.restriction_sid},
            files:inventory.files.into_iter().map(|file|StoredFile{relative:file.relative,identity:file.identity,bytes:file.bytes,sha256:file.sha256}).collect(),
            directories:inventory.directories.into_iter().map(|directory|StoredDirectory{relative:directory.relative,identity:directory.identity}).collect(),
            job_key:"c".repeat(64)}
    }
    #[test]
    fn known_command_cold_actual_partial_checkpoint_exact_retry_and_foreign_refusals(){
        let parent=std::env::temp_dir().join(format!("dac-known-command-cold-{}-{}",std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let data=parent.join("data");let project=parent.join("project");std::fs::create_dir_all(&parent).unwrap();
        let original=LockedPath::open(&parent,true,false).unwrap();let descriptor=Descriptor::current_user().unwrap();
        drop(no_follow::create_private_child(&original.file,"data",true,descriptor.pointer()).unwrap());
        drop(no_follow::create_private_child(&original.file,"project",true,descriptor.pointer()).unwrap());drop(original);
        unsafe{std::env::set_var("DEEPAGENT_CODE_TEST_HOME",&parent);std::env::set_var("DEEPAGENT_CODE_HOME",&data);}
        let request=fixture(&data,&project,'1');
        let mut wrong=request.clone();wrong.security.lease_set_hash="0".repeat(64);assert!(Collector::open(wrong).is_err());
        let mut wrong=request.clone();wrong.files[0].sha256="0".repeat(64);assert!(Collector::open(wrong).is_err());
        let original=data.join("work-command-stage").join(&request.basename);
        let collector=Collector::open(request.clone()).unwrap();assert!(original.is_dir());assert!(!collector.complete);
        drop(collector);
        let mut collector=Collector::open(request.clone()).unwrap();TEST_STOP_AFTER.store(1,std::sync::atomic::Ordering::SeqCst);
        assert!(collector.collect().is_err());assert!(collector.is_unknown());assert!(!original.exists());
        let quarantine=data.join("work-command-stage").join(&request.quarantine);assert!(quarantine.is_dir());drop(collector);
        TEST_STOP_AFTER.store(usize::MAX,std::sync::atomic::Ordering::SeqCst);
        let mut cold=Collector::open(request.clone()).unwrap();assert_eq!(cold.progress.step,1);cold.collect().unwrap();assert!(cold.complete);drop(cold);
        assert!(!quarantine.exists());
        let mut retry=Collector::open(request.clone()).unwrap();assert!(retry.complete);retry.collect().unwrap();drop(retry);
        let mut wrong=request.clone();wrong.plan_hash="d".repeat(64);assert!(Collector::open(wrong).is_err());
        let completed=request.clone();
        let request=fixture(&data,&project,'2');let original=data.join("work-command-stage").join(&request.basename);
        let owned=LockedPath::open(&original,true,false).unwrap();let descriptor=Descriptor::current_user().unwrap();
        drop(no_follow::create_private_child(&owned.file,"foreign.txt",false,descriptor.pointer()).unwrap());drop(owned);
        assert!(Collector::open(request.clone()).is_err());assert!(original.join("foreign.txt").exists());
        let marker=data.join("work-command-stage").join(format!("proof_{}.json",hash(format!("wcleanup_{}","1".repeat(64)).as_bytes())));
        std::fs::write(marker,b"{}".as_slice()).unwrap();assert!(Collector::open(completed).is_err());
        std::fs::remove_dir_all(parent).unwrap();
    }
}
