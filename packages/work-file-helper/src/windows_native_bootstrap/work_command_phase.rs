//! Original workspace ACL custody, attached only by its Native command owner.
//! Descriptions expose observations; they cannot construct this phase object.
use super::work_workspace::{Workspace,WorkspacePhase,WorkspacePhaseState};
use crate::{no_follow::{self,LockedPath},protocol::Identity};
use sha2::{Digest,Sha256};
use std::{collections::BTreeSet,ffi::c_void,fs::File,io,mem::{size_of,MaybeUninit},os::windows::{ffi::OsStrExt,
    io::{AsRawHandle,FromRawHandle,OwnedHandle,RawHandle}},path::{Path,PathBuf},ptr,sync::{Arc,Mutex,atomic::{AtomicU8,Ordering}}};
use windows_sys::Win32::{Foundation::{HANDLE,PSID,LocalFree,NTSTATUS,RtlNtStatusToDosError,UNICODE_STRING},
    Security::{GetSecurityDescriptorControl,GetSecurityDescriptorDacl,GetSecurityDescriptorOwner,SE_DACL_PROTECTED,
        OWNER_SECURITY_INFORMATION,DACL_SECURITY_INFORMATION,GetLengthSid,EqualSid,FreeSid,
        Authorization::{EXPLICIT_ACCESS_W,GRANT_ACCESS,TRUSTEE_W,TRUSTEE_IS_SID,TRUSTEE_IS_UNKNOWN,SetEntriesInAclW,
            GetSecurityInfo,SE_FILE_OBJECT,ConvertSidToStringSidW,ConvertStringSidToSidW},Isolation::DeriveAppContainerSidFromAppContainerName},
    Storage::FileSystem::{FILE_STANDARD_INFO,FileStandardInfo,GetFileInformationByHandleEx},
    System::{IO::{IO_STATUS_BLOCK,IO_STATUS_BLOCK_0},Kernel::{OBJ_CASE_INSENSITIVE,OBJ_DONT_REPARSE}}};
struct Member{relative:String,identity:Identity,file:Mutex<Option<File>>,path:PathBuf,owner:Vec<u8>,original:Vec<u8>,granted:Vec<u8>}
/// Read-only descriptor facts for an authenticated known-command collector.
/// These values are not a Phase, StopProof, AppContainer or ACL lease.
pub(crate) struct KnownSecurityFacts {
    pub lease_set_hash: String, pub acl_restore_hash: String,
    pub app_container_sid: String, pub restriction_sid: String,
}

pub(crate) fn inspect_known_security(descriptors: &[(String, Identity, Vec<u8>)], nonce: &str,
    inputs: &[String], outputs: &[String]) -> io::Result<KnownSecurityFacts> {
    if nonce.len() != 64 || !nonce.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)) ||
        descriptors.is_empty() || descriptors.len() > 4898 { return Err(io::ErrorKind::InvalidInput.into()); }
    let profile = format!("DAC.Work.{}", &nonce[..32]).encode_utf16().chain([0]).collect::<Vec<_>>();
    let mut app = ptr::null_mut();
    if unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut app) } != 0 || app.is_null() {
        return Err(io::ErrorKind::Unsupported.into());
    }
    let mut restriction = ptr::null_mut();
    let result = (|| -> io::Result<KnownSecurityFacts> {
        let app_sid = sid_text(app)?;
        let numbers = nonce.as_bytes().chunks_exact(8).take(4).map(|chunk|
            u32::from_str_radix(std::str::from_utf8(chunk).map_err(|_| io::ErrorKind::InvalidData)?, 16)
                .map(|value| value.to_string()).map_err(io::Error::other)).collect::<io::Result<Vec<_>>>()?;
        let restriction_sid = format!("S-1-5-21-{}", numbers.join("-"));
        if unsafe { ConvertStringSidToSidW(restriction_sid.encode_utf16().chain([0]).collect::<Vec<_>>().as_ptr(), &mut restriction) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let ancestors = inputs.iter().chain(outputs).flat_map(|name| {
            let parts = name.split('/').collect::<Vec<_>>();
            (1..parts.len()).map(move |count| parts[..count].join("/"))
        }).collect::<BTreeSet<_>>();
        let members = descriptors.iter().map(|(relative, identity, descriptor)| {
            let mut owner = ptr::null_mut(); let mut owner_default = 0;
            let mut dacl = ptr::null_mut(); let mut present = 0; let mut default = 0;
            let mut control = 0; let mut revision = 0;
            let pointer = descriptor.as_ptr() as *mut c_void;
            if unsafe { GetSecurityDescriptorOwner(pointer, &mut owner, &mut owner_default) } == 0 ||
                unsafe { GetSecurityDescriptorDacl(pointer, &mut present, &mut dacl, &mut default) } == 0 ||
                unsafe { GetSecurityDescriptorControl(pointer, &mut control, &mut revision) } == 0 ||
                owner.is_null() || dacl.is_null() || present == 0 || control & SE_DACL_PROTECTED == 0 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let original = acl_bytes(dacl, 2)?;
            let mask = if outputs.contains(relative) { Some(0x0012_019f) }
                else if relative.is_empty() || ancestors.contains(relative) { Some(0x0012_00a9) }
                else if inputs.contains(relative) { Some(0x0012_0089) } else { None };
            let granted = match mask {
                None => original.clone(), Some(mask) => {
                    let entry = |sid| EXPLICIT_ACCESS_W { grfAccessPermissions: mask, grfAccessMode: GRANT_ACCESS,
                        grfInheritance: 0, Trustee: TRUSTEE_W { pMultipleTrustee: ptr::null_mut(), MultipleTrusteeOperation: 0,
                            TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid } };
                    let entries = [entry(restriction.cast()), entry(app.cast())]; let mut changed = ptr::null_mut();
                    let result = unsafe { SetEntriesInAclW(2, entries.as_ptr(), dacl, &mut changed) };
                    if result != 0 { return Err(io::Error::from_raw_os_error(result as i32)); }
                    let value = acl_bytes(changed, 4); unsafe { LocalFree(changed.cast()); } value?
                }
            };
            let length = unsafe { GetLengthSid(owner) } as usize;
            if !(8..=68).contains(&length) { return Err(io::ErrorKind::InvalidData.into()); }
            // Hash-only temporary members never acquire a Phase state or live file lease.
            Ok(Member { relative: relative.clone(), identity: identity.clone(), file: Mutex::new(None), path: PathBuf::new(),
                owner: unsafe { std::slice::from_raw_parts(owner.cast::<u8>(), length) }.to_vec(), original, granted })
        }).collect::<io::Result<Vec<_>>>()?;
        Ok(KnownSecurityFacts {
            lease_set_hash: hash(&members, b"dac.windows.original-acl-leases.v1\0", true, &app_sid, &restriction_sid),
            acl_restore_hash: hash(&members, b"dac.windows.original-acl-retirement.v1\0", false, &app_sid, &restriction_sid),
            app_container_sid: app_sid, restriction_sid,
        })
    })();
    if !restriction.is_null() { unsafe { LocalFree(restriction); } }
    unsafe { FreeSid(app); }
    result
}
pub(super) struct Phase{members:Vec<Member>,state:AtomicU8,granted:AtomicU8,app_sid:String,restriction_sid:String,lease_hash:String,restore_hash:String}
struct Descriptor{allocation:*mut c_void,owner:PSID,dacl:*mut windows_sys::Win32::Security::ACL,protected:bool}
impl Drop for Descriptor{fn drop(&mut self){unsafe{LocalFree(self.allocation);}}}
impl Descriptor{
    fn read(file:&File)->io::Result<Self>{
        let mut allocation=ptr::null_mut();let mut owner=ptr::null_mut();let mut dacl=ptr::null_mut();
        let result=unsafe{GetSecurityInfo(file.as_raw_handle()as HANDLE,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
            &mut owner,ptr::null_mut(),&mut dacl,ptr::null_mut(),&mut allocation)};
        if result!=0{return Err(io::Error::from_raw_os_error(result as i32));}
        let mut control=0;let mut revision=0;
        if unsafe{GetSecurityDescriptorControl(allocation,&mut control,&mut revision)}==0||owner.is_null()||dacl.is_null(){unsafe{LocalFree(allocation);}return Err(io::ErrorKind::PermissionDenied.into());}
        Ok(Self{allocation,owner,dacl,protected:control&SE_DACL_PROTECTED!=0})
    }
}
impl Phase{
    pub(super) fn capture(workspace:&mut Workspace,nonce:&str,inputs:&[String],outputs:&[String])->io::Result<Arc<Self>>{
        let(directory,identity)=workspace.command_location()?;
        let directories=workspace.observe_inventory()?.directories.into_iter().map(|directory|directory.relative).collect::<BTreeSet<_>>();
        let original=workspace.command_descriptors()?;
        let root=LockedPath::open(&directory,true,false)?;
        if no_follow::identity(&root.file)?!=identity{return Err(io::ErrorKind::PermissionDenied.into());}
        let mut app=ptr::null_mut();
        let profile=format!("DAC.Work.{}",&nonce[..32]).encode_utf16().chain([0]).collect::<Vec<_>>();
        let derived=unsafe{DeriveAppContainerSidFromAppContainerName(profile.as_ptr(),&mut app)};
        if derived!=0||app.is_null(){eprintln!("WINDOWS_COMMAND_PHASE_FAILURE stage=derive-profile hresult={derived}");return Err(io::ErrorKind::Unsupported.into());}
        let app_sid=sid_text(app);let mut restriction=ptr::null_mut();
        let numbers=nonce.as_bytes().chunks_exact(8).take(4).map(|chunk|u32::from_str_radix(std::str::from_utf8(chunk).map_err(|_|io::ErrorKind::InvalidData)?,16).map(|value|value.to_string()).map_err(io::Error::other)).collect::<io::Result<Vec<_>>>();
        let result=(||->io::Result<Vec<Member>>{
            let text=format!("S-1-5-21-{}",numbers?.join("-"));
            if unsafe{ConvertStringSidToSidW(text.encode_utf16().chain([0]).collect::<Vec<_>>().as_ptr(),&mut restriction)}==0{return Err(io::Error::last_os_error());}
            let ancestors=inputs.iter().chain(outputs).flat_map(|name|{let parts=name.split('/').collect::<Vec<_>>();(1..parts.len()).map(move|count|parts[..count].join("/"))}).collect::<BTreeSet<_>>();
            original.into_iter().map(|(relative,identity,descriptor)|{
                let mut owner=ptr::null_mut();let mut owner_default=0;let mut dacl=ptr::null_mut();let mut present=0;let mut default=0;
                let mut control=0;let mut revision=0;
                let pointer=descriptor.as_ptr()as *mut c_void;
                if unsafe{GetSecurityDescriptorOwner(pointer,&mut owner,&mut owner_default)}==0||unsafe{GetSecurityDescriptorDacl(pointer,&mut present,&mut dacl,&mut default)}==0||
                    unsafe{GetSecurityDescriptorControl(pointer,&mut control,&mut revision)}==0||owner.is_null()||dacl.is_null()||present==0||control&SE_DACL_PROTECTED==0{
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                let original=acl_bytes(dacl,2)?;
                let mask=if outputs.contains(&relative){Some(0x0012_019f)}else if relative.is_empty()||ancestors.contains(&relative){Some(0x0012_00a9)}else if inputs.contains(&relative){Some(0x0012_0089)}else{None};
                let granted=match mask{
                    None=>original.clone(),Some(mask)=>{
                        let entry=|sid|EXPLICIT_ACCESS_W{grfAccessPermissions:mask,grfAccessMode:GRANT_ACCESS,grfInheritance:0,
                            Trustee:TRUSTEE_W{pMultipleTrustee:ptr::null_mut(),MultipleTrusteeOperation:0,TrusteeForm:TRUSTEE_IS_SID,
                                TrusteeType:TRUSTEE_IS_UNKNOWN,ptstrName:sid}};
                        let entries=[entry(restriction.cast()),entry(app.cast())];let mut changed=ptr::null_mut();
                        let result=unsafe{SetEntriesInAclW(2,entries.as_ptr(),dacl,&mut changed)};
                        if result!=0{return Err(io::Error::from_raw_os_error(result as i32));}
                        let bytes=acl_bytes(changed,4);unsafe{LocalFree(changed.cast());}bytes?
                    }
                };
                let length=unsafe{GetLengthSid(owner)}as usize;
                if !(8..=68).contains(&length){return Err(io::ErrorKind::InvalidData.into());}
                let owner=unsafe{std::slice::from_raw_parts(owner.cast::<u8>(),length)}.to_vec();
                let directory_member=directories.contains(&relative);
                let file=if relative.is_empty(){root.file.try_clone()?}else{open_member(&root.file,&relative,directory_member,outputs.contains(&relative))?};
                let path=if relative.is_empty(){root.canonical().to_owned()}else{root.canonical().join(relative.replace('/',"\\"))};
                if no_follow::identity(&file)?!=identity||no_follow::final_path(&file)?!=path{return Err(io::ErrorKind::PermissionDenied.into());}
                let actual=Descriptor::read(&file)?;
                if !actual.protected||unsafe{EqualSid(actual.owner,owner.as_ptr()as PSID)}==0||acl_bytes(actual.dacl,2)?!=original{return Err(io::ErrorKind::PermissionDenied.into());}
                Ok(Member{relative,identity,file:Mutex::new(Some(file)),path,owner,original,granted})
            }).collect()
        })();
        if !restriction.is_null(){unsafe{LocalFree(restriction);}}
        unsafe{FreeSid(app);}
        let members=result?;let app_sid=app_sid?;
        let restriction_sid=format!("S-1-5-21-{}",nonce.as_bytes().chunks_exact(8).take(4).map(|chunk|u32::from_str_radix(std::str::from_utf8(chunk).expect("validated nonce"),16).expect("validated nonce").to_string()).collect::<Vec<_>>().join("-"));
        let lease_hash=hash(&members,b"dac.windows.original-acl-leases.v1\0",true,&app_sid,&restriction_sid);
        let restore_hash=hash(&members,b"dac.windows.original-acl-retirement.v1\0",false,&app_sid,&restriction_sid);
        let phase=Arc::new(Self{members,state:AtomicU8::new(0),granted:AtomicU8::new(0),app_sid,restriction_sid,lease_hash,restore_hash});
        workspace.attach_phase(phase.clone(),&identity)?;Ok(phase)
    }
    pub(super) fn ready(&self)->io::Result<()>{
        if self.state.load(Ordering::Acquire)!=0{return Err(io::ErrorKind::PermissionDenied.into());}
        self.granted.store(1,Ordering::Release);self.verify().inspect_err(|_|self.unknown())
    }
    pub(super) fn running(&self)->io::Result<()>{self.verify()?;if self.granted.load(Ordering::Acquire)!=1||self.state.compare_exchange(0,1,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err(io::ErrorKind::PermissionDenied.into());}Ok(())}
    pub(super) fn retired(&self)->io::Result<()>{
        if self.state.load(Ordering::Acquire)>1{return Err(io::ErrorKind::PermissionDenied.into());}
        self.granted.store(0,Ordering::Release);self.state.store(2,Ordering::Release);self.verify().inspect_err(|_|self.unknown())?;
        // Stop has authenticated exact restoration. Release the temporary
        // no-DELETE observation handles before the workspace's original known
        // cleanup can acquire DELETE on these same named FileIDs.
        for member in &self.members{member.file.lock().map_err(|_|io::ErrorKind::Other)?.take();}Ok(())
    }
    pub(super) fn unknown(&self){self.state.store(3,Ordering::Release);}
    pub(super) fn description(&self)->serde_json::Value{
        serde_json::json!({"version":1,"phase":match self.state(){WorkspacePhaseState::Ready=>"ready",WorkspacePhaseState::Running=>"running",WorkspacePhaseState::Retired=>"retired",WorkspacePhaseState::Unknown=>"unknown"},
            "security":{"leaseSetHash":self.lease_hash,"appContainerSID":self.app_sid,"restrictionSID":self.restriction_sid},
            "aclRestoreHash":if self.state()==WorkspacePhaseState::Retired{Some(self.restore_hash.as_str())}else{None}})
    }
    fn verify(&self)->io::Result<()>{for member in &self.members{let file=member.file.lock().map_err(|_|io::ErrorKind::Other)?;self.validate(file.as_ref().ok_or(io::ErrorKind::PermissionDenied)?,&member.relative)?;}Ok(())}
}
impl WorkspacePhase for Phase{
    fn state(&self)->WorkspacePhaseState{match self.state.load(Ordering::Acquire){0=>WorkspacePhaseState::Ready,1=>WorkspacePhaseState::Running,2=>WorkspacePhaseState::Retired,_=>WorkspacePhaseState::Unknown}}
    fn validate(&self,file:&File,relative:&str)->io::Result<()>{
        if matches!(self.state(),WorkspacePhaseState::Running|WorkspacePhaseState::Unknown){return Err(io::ErrorKind::PermissionDenied.into());}
        let member=self.members.iter().find(|member|member.relative==relative).ok_or(io::ErrorKind::PermissionDenied)?;
        let actual=Descriptor::read(file)?;
        if no_follow::identity(file)?!=member.identity||no_follow::final_path(file)?!=member.path||!actual.protected||
            unsafe{EqualSid(actual.owner,member.owner.as_ptr()as PSID)}==0||acl_bytes(actual.dacl,u16::from_le_bytes(if self.granted.load(Ordering::Acquire)==1{[member.granted[4],member.granted[5]]}else{[member.original[4],member.original[5]]}))?.as_slice()!=if self.granted.load(Ordering::Acquire)==1{member.granted.as_slice()}else{member.original.as_slice()}{
            return Err(io::ErrorKind::PermissionDenied.into());
        }Ok(())
    }
}
fn hash(members:&[Member],domain:&[u8],granted:bool,app:&str,restriction:&str)->String{
    let mut hash=Sha256::new();hash.update(domain);hash.update(app);hash.update([0]);hash.update(restriction);hash.update([0]);
    for member in members{hash.update(member.relative.as_bytes());hash.update([0]);hash.update(serde_json::to_vec(&member.identity).expect("identity serialization"));hash.update(&member.owner);hash.update(&member.original);if granted{hash.update(&member.granted);}}
    format!("{:x}",hash.finalize())
}
fn acl_bytes(value:*mut windows_sys::Win32::Security::ACL,count:u16)->io::Result<Vec<u8>>{crate::native_windows::acl::bytes(value,count)}
fn sid_text(value:PSID)->io::Result<String>{let mut text=ptr::null_mut();if unsafe{ConvertSidToStringSidW(value,&mut text)}==0{return Err(io::Error::last_os_error());}let mut length=0;while length<256&&unsafe{*text.add(length)}!=0{length+=1;}let result=String::from_utf16(unsafe{std::slice::from_raw_parts(text,length)}).map_err(io::Error::other);unsafe{LocalFree(text.cast());}result}
#[repr(C)]struct ObjectAttributes{length:u32,root_directory:HANDLE,object_name:*const UNICODE_STRING,attributes:u32,security_descriptor:*const c_void,security_quality_of_service:*const c_void}
#[link(name="ntdll")]unsafe extern "system"{fn NtCreateFile(handle:*mut HANDLE,access:u32,attributes:*const ObjectAttributes,status:*mut IO_STATUS_BLOCK,allocation:*const i64,
    flags:u32,share:u32,disposition:u32,options:u32,ea:*const c_void,ea_length:u32)->NTSTATUS;}
fn open_member(root:&File,relative:&str,directory:bool,writable:bool)->io::Result<File>{
    let parts=no_follow::relative(relative)?;let mut parent=root.try_clone()?;
    for(index,part)in parts.iter().enumerate(){let final_part=index==parts.len()-1;let directory=if final_part{directory}else{true};
        let mut text=part.encode_utf16().collect::<Vec<_>>();let size=u16::try_from(text.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
        let name=UNICODE_STRING{Length:size,MaximumLength:size,Buffer:text.as_mut_ptr()};let attributes=ObjectAttributes{length:size_of::<ObjectAttributes>()as u32,root_directory:parent.as_raw_handle()as HANDLE,
            object_name:&name,attributes:OBJ_CASE_INSENSITIVE as u32|OBJ_DONT_REPARSE as u32,security_descriptor:ptr::null(),security_quality_of_service:ptr::null()};
        let mut status=IO_STATUS_BLOCK{Anonymous:IO_STATUS_BLOCK_0{Status:0},Information:0};let mut handle=0;
        let code=unsafe{NtCreateFile(&mut handle,0x0012_0080,&attributes,&mut status,ptr::null(),0x80,1|if final_part&&writable{2}else{0},1,(if directory{1}else{0x40})|0x20,ptr::null(),0)};
        if code<0{return Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(code)}as i32));}
        parent=File::from(unsafe{OwnedHandle::from_raw_handle(handle as RawHandle)});
        if parent.metadata()?.is_dir()!=directory{return Err(io::ErrorKind::PermissionDenied.into());}
        if !directory{let mut info=MaybeUninit::<FILE_STANDARD_INFO>::uninit();if unsafe{GetFileInformationByHandleEx(handle,FileStandardInfo,info.as_mut_ptr().cast(),size_of::<FILE_STANDARD_INFO>()as u32)}==0||unsafe{info.assume_init()}.NumberOfLinks!=1{return Err(io::ErrorKind::PermissionDenied.into());}}
    }Ok(parent)
}
