//! Held repository/index/target namespaces for the trusted builtin Git producer.
//! No value in this module is a model grant or an LPAC payload permission.
use super::{event_git::Git, event_git_protocol, loader, work_factory::WorkFactory, work_process::Child};
use crate::{no_follow::{self, LockedPath}, private_directory::{self, Descriptor}, protocol::Identity};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::{self, Read, Seek, SeekFrom}, path::{Path, PathBuf}, time::{Duration, Instant}};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Open { pub directory: String, pub expected: Identity }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Run { pub args: Vec<String>, pub blob: bool, pub commit_time: Option<u64> }
pub(super) struct Result { pub code: i32, pub stdout: Vec<u8>, pub stderr: Vec<u8> }
struct Index { root: File, parent: LockedPath, identity: Identity, directory: PathBuf, basename: String, unknown: bool }
pub(super) struct Repository { root: LockedPath, marker: LockedPath, common: LockedPath, administration: Option<LockedPath>,
    directory: PathBuf, common_path: PathBuf, administration_path: Option<PathBuf>, configuration: Option<(LockedPath,String)>, metadata: Vec<LockedPath>, marker_stamp: Option<String>, index: Option<Index>,
    targets: BTreeMap<PathBuf, LockedPath>, unknown: bool, retained: Vec<Child> }
impl Repository {
    pub(super) fn open(request: Open) -> io::Result<Self> {
        event_git_protocol::validate(&["rev-parse".into(), "HEAD".into()], 0, false, None, &request.directory, None)?;
        let directory = PathBuf::from(&request.directory);
        let root = LockedPath::open_event_directory(&directory)?;
        if no_follow::identity(&root.file)? != request.expected { return Err(io::ErrorKind::PermissionDenied.into()); }
        loader::require_trusted(&root.file)?;
        let marker = LockedPath::member(&root, &[".git"], true, false).or_else(|error| {
            if matches!(error.raw_os_error(), Some(267) | Some(87)) { LockedPath::member(&root, &[".git"], false, false) } else { Err(error) }
        })?;
        loader::require_trusted(&marker.file)?;
        let (common_path, administration, marker_stamp) = if marker.file.metadata()?.is_dir() {
            (directory.join(".git"), None, None)
        } else {
            let value = text(&marker.file, 8192)?;
            let named = value.strip_prefix("gitdir: ").and_then(|value| value.strip_suffix('\n')).ok_or(io::ErrorKind::InvalidData)?;
            let named = named.strip_suffix('\r').unwrap_or(named);
            let path = absolute_member(&directory, named)?;
            let administration = LockedPath::open(&path, true, false)?;
            loader::require_trusted(&administration.file)?;
            let common_marker = LockedPath::member(&administration, &["commondir"], false, false)?;
            if text(&common_marker.file, 8192)?.trim_end_matches(['\r','\n']) != "../.." { return Err(io::ErrorKind::PermissionDenied.into()); }
            let common = path.parent().and_then(Path::parent).ok_or(io::ErrorKind::InvalidData)?.to_owned();
            if path.parent().and_then(Path::file_name).and_then(|value|value.to_str()) != Some("worktrees") {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let reverse = LockedPath::member(&administration, &["gitdir"], false, false)?;
            let reverse_name = text(&reverse.file, 8192)?.trim_end_matches(['\r','\n']).replace('/',"\\");
            if !reverse_name.eq_ignore_ascii_case(directory.join(".git").to_str().ok_or(io::ErrorKind::InvalidData)?) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            (common, Some(administration), Some(no_follow::stamp(&marker.file)?))
        };
        let administration_path=if administration.is_some(){
            let value=text(&marker.file,8192)?;
            Some(absolute_member(&directory,value.trim_end_matches(['\r','\n']).strip_prefix("gitdir: ").ok_or(io::ErrorKind::InvalidData)?)?)
        }else{None};
        let common = LockedPath::open(&common_path, true, false)?;
        loader::require_trusted(&common.file)?;
        // Git object replacement/alternates can select storage outside this
        // original namespace. They are not part of the builtin Event contract.
        let objects = LockedPath::member(&common, &["objects"], true, false)?;
        for leaf in ["alternates", "http-alternates"] {
            if LockedPath::member(&objects, &["info", leaf], false, false).is_ok() { return Err(io::ErrorKind::PermissionDenied.into()); }
        }
        let metadata=[vec!["objects"],vec!["objects","info"],vec!["objects","pack"],vec!["refs"],vec!["refs","heads"]].into_iter()
            .map(|parts|LockedPath::member(&common,&parts,true,false)).collect::<io::Result<Vec<_>>>()?;
        for value in &metadata{loader::require_trusted(&value.file)?;}
        let configuration=match LockedPath::member(&common,&["config"],false,false){
            Ok(value)=>{loader::require_trusted(&value.file)?;if value.file.metadata()?.len()>1_048_576{return Err(io::ErrorKind::InvalidData.into());}let stamp=no_follow::stamp(&value.file)?;Some((value,stamp))},
            Err(error)if error.kind()==io::ErrorKind::NotFound=>None,Err(error)=>return Err(error),};
        let value = Self { root, marker, common, administration, directory, common_path, administration_path, configuration, metadata, marker_stamp,
            index: None, targets: BTreeMap::new(), unknown: false, retained: Vec::new() };
        value.current()?; Ok(value)
    }
    pub(super) fn current(&self) -> io::Result<()> {
        if self.unknown || !self.retained.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        for value in [&self.root,&self.marker,&self.common] { value.current()?; loader::require_trusted(&value.file)?; }
        if self.marker_stamp.as_ref().is_some_and(|stamp| no_follow::stamp(&self.marker.file).ok().as_ref()!=Some(stamp)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if let Some(value)=&self.administration { value.current()?; loader::require_trusted(&value.file)?; }
        for value in &self.metadata{value.current()?;loader::require_trusted(&value.file)?;}
        if let Some((value,stamp))=&self.configuration {value.current()?;loader::require_trusted(&value.file)?;if no_follow::stamp(&value.file)?!=*stamp{return Err(io::ErrorKind::PermissionDenied.into());}}
        if let Some(value)=&self.index { value.current()?; }
        for value in self.targets.values(){value.current()?;private_directory::require_private(&value.file)?;}
        Ok(())
    }
    pub(super) fn describe(&self, git: &Git) -> io::Result<String> {
        self.current()?;
        Ok(serde_json::to_string(&serde_json::json!({"version":1,"purpose":"fixed-event-git-repository",
            "directory":self.directory,"git_directory":self.common_path,"root":no_follow::identity(&self.root.file)?,
            "git_root":no_follow::identity(&self.common.file)?,"runtime":serde_json::from_str::<serde_json::Value>(git.describe()?)?,
            "work_authority":false}))?)
    }
    pub(super) fn open_index(&mut self, factory:&WorkFactory)->io::Result<String>{
        self.current()?; if self.index.is_some(){return Err(io::ErrorKind::WouldBlock.into());}
        let data=LockedPath::open(factory.data_path(),true,false)?;
        let parent=private_child(&data,"event-git-index")?;
        let basename=format!("dac-event-index-{}",random_hex()?);
        let directory=factory.data_path().join("event-git-index").join(&basename);
        let descriptor=Descriptor::current_user()?;
        let root=create_index(&parent.file,&basename,descriptor.pointer())?;
        let identity=no_follow::identity(&root)?;private_directory::require_private(&root)?;
        self.index=Some(Index{root,parent,identity,directory,basename,unknown:false});
        self.index.as_ref().ok_or(io::ErrorKind::Other)?.describe()
    }
    pub(super) fn index_allocation(&self)->io::Result<u64>{
        self.current()?; let index=self.index.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
        let file=member(&index.root,"index",false)?;loader::require_trusted(&file)?;
        let before=no_follow::stamp(&file)?;
        let size=allocation(&file)?;
        if size>16_777_216||no_follow::stamp(&file)?!=before{return Err(io::ErrorKind::InvalidData.into());}
        index.current()?;Ok(size)
    }
    pub(super) fn close_index(&mut self)->io::Result<()> {
        self.current()?;let Some(index)=self.index.as_ref()else{return Err(io::ErrorKind::PermissionDenied.into());};
        index.current()?;
        // An interrupted Git index transaction is never cleaned by a guessed
        // filename. Known success admits only its exact final index leaf.
        if member(&index.root,"index.lock",false).is_ok(){return Err(io::ErrorKind::WouldBlock.into());}
        let file=match crate::event_worktree::windows_observation::deleting(&index.root,"index",false){
            Ok(file)=>Some(file),Err(error)if error.kind()==io::ErrorKind::NotFound=>None,Err(error)=>return Err(error),};
        if let Some(file)=&file {loader::require_trusted(file)?;if file.metadata()?.len()>16_777_216{return Err(io::ErrorKind::InvalidData.into());}}
        let names=directory_names(&index.root)?;
        if names.iter().any(|name|name!="index") || names.len()!=usize::from(file.is_some()){return Err(io::ErrorKind::PermissionDenied.into());}
        // Mark the original custody unknown before deletion. Only exact absence
        // through the still-held parent returns it to a known closed state.
        self.index.as_mut().ok_or(io::ErrorKind::Other)?.unknown=true;
        if let Some(file)=file{dispose(&file)?;drop(file);}
        let index=self.index.as_ref().ok_or(io::ErrorKind::Other)?;
        if !directory_names(&index.root)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
        dispose(&index.root)?;
        let index=self.index.take().ok_or(io::ErrorKind::Other)?;
        let parent=index.parent;let basename=index.basename;drop(index.root);
        parent.current()?;
        match member(&parent.file,&basename,true){Err(error)if error.kind()==io::ErrorKind::NotFound=>{},_=>{self.unknown=true;return Err(io::ErrorKind::PermissionDenied.into());}}
        Ok(())
    }
    pub(super) fn run(&mut self,factory:&WorkFactory,git:&Git,request:Run,stdin:&[u8])->io::Result<Result>{
        self.current()?;git.current()?;
        let creating=request.args.first().is_some_and(|value|value=="worktree")&&request.args.get(1).is_some_and(|value|value=="add");
        let target=if creating{Some(self.target(factory,&request.args)?)}else{None};
        let mut plan=event_git_protocol::validate(&request.args,stdin.len(),request.blob,request.commit_time,
            self.directory.to_str().ok_or(io::ErrorKind::InvalidData)?,target.as_deref().and_then(Path::to_str))?;
        if creating&&request.args.len()==6{
            // Git's -b form forks `git branch`, which the one-process Job
            // correctly rejects. Publish only this fixed branch with the
            // existing old-zero CAS grammar, retire that original Job, then
            // register the already-existing branch without a child process.
            let branch=&request.args[3];let base=&request.args[5];
            let result=self.run(factory,git,Run{args:vec!["update-ref".into(),format!("refs/heads/{branch}"),base.clone(),"0".repeat(base.len())],blob:false,commit_time:None},&[])?;
            if result.code!=0{return Err(io::Error::other("EVENT_GIT_PHYSICAL_UNKNOWN"));}
            plan.argv=vec!["worktree".into(),"add".into(),"--no-checkout".into(),request.args[4].clone(),branch.clone()];
        }
        if matches!(plan.argv[0].as_str(),"read-tree"|"update-index"|"write-tree")&&self.index.is_none(){return Err(io::ErrorKind::PermissionDenied.into());}
        let mut args=["-c","core.hooksPath=NUL","-c","core.fsmonitor=false","-c","submodule.recurse=false","-c","commit.gpgSign=false",
            "-c","gc.auto=0","-c","core.pager=cat","-c","core.attributesFile=NUL"].into_iter().map(str::to_owned).collect::<Vec<_>>();args.extend(plan.argv);
        let environment=self.environment(factory,request.commit_time)?;
        let mut child=Child::launch_git(factory,git,&args,&self.directory,&environment)?;
        let started=Instant::now();let mut offset=0;let mut ended=false;let mut stdout=Vec::new();let mut stderr=Vec::new();
        let result=(||->io::Result<i32>{loop{
            if started.elapsed()>=Duration::from_secs(30){return Err(io::ErrorKind::TimedOut.into());}
            self.current()?;git.current()?;
            if !ended{
                if offset<stdin.len(){let end=(offset+65_536).min(stdin.len());match child.write(stdin[offset..end].to_vec()){
                    Ok(())=>offset=end,Err(error)if error.kind()==io::ErrorKind::WouldBlock=>{},Err(error)=>return Err(error),}}
                if offset==stdin.len(){child.end()?;ended=true;}
            }
            let observed=child.read()?;
            match observed.kind{
                "stdout"=>{if stdout.len()+observed.bytes.len()>plan.stdout_bytes{return Err(io::ErrorKind::InvalidData.into());}stdout.extend(observed.bytes);},
                "stderr"=>{if stderr.len()+observed.bytes.len()>1_048_576{return Err(io::ErrorKind::InvalidData.into());}stderr.extend(observed.bytes);},
                "exit"=>return observed.exit_code.ok_or_else(||io::ErrorKind::InvalidData.into()),_=>std::thread::sleep(Duration::from_millis(2)),}
        }})();
        let code=match result{Ok(code)=>code,Err(error)=>{
            if plan.mutating{self.unknown=true;if let Some(index)=self.index.as_mut(){index.unknown=true;}}
            if let Err(child)=child.retire(){self.retained.push(child);}
            return Err(if plan.mutating || !self.retained.is_empty(){io::Error::other("EVENT_GIT_PHYSICAL_UNKNOWN")}else{error});
        }};
        if !child.close()?{self.unknown=true;self.retained.push(child);return Err(io::Error::other("EVENT_GIT_PHYSICAL_UNKNOWN"));}
        if code!=0 && plan.mutating{
            physical_failure("child-code",code,&stderr);
            self.unknown=true;return Err(io::Error::other("EVENT_GIT_PHYSICAL_UNKNOWN"));
        }
        let observed=(||->io::Result<()>{
            if let Some(target)=target{let observed=LockedPath::open_event_directory(&target)?;private_directory::require_private(&observed.file)?;self.targets.insert(target,observed);}
            self.current()?;git.current()
        })();
        if let Err(error)=observed {
            eprintln!("WINDOWS_EVENT_GIT_PHYSICAL_FAILURE stage=postcurrent kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));
            if plan.mutating{self.unknown=true;if let Some(index)=self.index.as_mut(){index.unknown=true;}return Err(io::Error::other("EVENT_GIT_PHYSICAL_UNKNOWN"));}
            return Err(error);
        }
        Ok(Result{code,stdout,stderr})
    }
    pub(super) fn can_close(&self)->bool{!self.unknown&&self.retained.is_empty()&&self.index.is_none()}
    pub(super) fn prepare_parent(&self,factory:&WorkFactory)->io::Result<String>{
        self.current()?;
        let parent_hash=format!("{:x}",Sha256::digest(self.directory.to_str().ok_or(io::ErrorKind::InvalidData)?.as_bytes()));
        let data=LockedPath::open(factory.data_path(),true,false)?;
        let base=private_child(&data,"worktree")?;let durable=private_child(&base,"durable")?;
        let parent=private_child(&durable,&parent_hash[..16])?;
        let directory=factory.data_path().join("worktree").join("durable").join(&parent_hash[..16]);
        self.current()?;parent.current()?;
        Ok(serde_json::to_string(&serde_json::json!({"version":1,"purpose":"fixed-event-parent-namespace",
            "directory":directory,"identity":no_follow::identity(&parent.file)?,"work_authority":false}))?)
    }
    fn target(&mut self,factory:&WorkFactory,args:&[String])->io::Result<PathBuf>{
        let (supplied,branch)=if args.len()==4{(&args[2],&args[3])}else if args.len()==6{(&args[4],&args[3])}else{return Err(io::ErrorKind::InvalidInput.into());};
        let suffix=branch.strip_prefix("deepagent-code/event-").ok_or(io::ErrorKind::PermissionDenied)?;
        if suffix.len()!=24||!suffix.bytes().all(|value|value.is_ascii_digit()||(b'a'..=b'f').contains(&value)){return Err(io::ErrorKind::PermissionDenied.into());}
        let parent_hash=format!("{:x}",Sha256::digest(self.directory.to_str().ok_or(io::ErrorKind::InvalidData)?.as_bytes()));
        let expected=factory.data_path().join("worktree").join("durable").join(&parent_hash[..16]).join(format!("event-{suffix}"));
        if Path::new(supplied)!=expected{return Err(io::ErrorKind::PermissionDenied.into());}
        let data=LockedPath::open(factory.data_path(),true,false)?;
        let base=private_child(&data,"worktree")?;let durable=private_child(&base,"durable")?;let parent=private_child(&durable,&parent_hash[..16])?;
        let target=private_new_event(&parent,&format!("event-{suffix}"))?;
        if !directory_names(&target.file)?.is_empty(){return Err(io::ErrorKind::PermissionDenied.into());}
        self.targets.insert(expected.clone(),target);
        Ok(expected)
    }
    fn environment(&self,factory:&WorkFactory,time:Option<u64>)->io::Result<Vec<u16>>{
        let mut values=BTreeMap::<String,String>::new();
        let raw=String::from_utf16(factory.windows_environment()).map_err(|_|io::ErrorKind::InvalidData)?;
        for value in raw.split('\0').filter(|value|!value.is_empty()){
            let(name,value)=value.split_once('=').ok_or(io::ErrorKind::InvalidData)?;
            if matches!(name,"SYSTEMROOT"|"WINDIR"){values.insert(name.into(),value.into());}
        }
        for (name,value)in[("GIT_CONFIG_NOSYSTEM","1"),("GIT_CONFIG_SYSTEM","NUL"),("GIT_CONFIG_GLOBAL","NUL"),("GIT_TERMINAL_PROMPT","0"),
            ("GIT_ALLOW_PROTOCOL",""),("GIT_OPTIONAL_LOCKS","0"),("GIT_ATTR_NOSYSTEM","1"),("GIT_NO_LAZY_FETCH","1"),("GIT_NO_REPLACE_OBJECTS","1"),
            ("GIT_AUTHOR_NAME","DeepAgent Code"),("GIT_AUTHOR_EMAIL","agent@deepagent.code"),("GIT_COMMITTER_NAME","DeepAgent Code"),("GIT_COMMITTER_EMAIL","agent@deepagent.code"),
            ("LANG","C"),("LC_ALL","C")] {values.insert(name.into(),value.into());}
        values.insert("GIT_DIR".into(),self.administration_path.as_ref().map_or(self.common_path.as_path(),PathBuf::as_path).to_str().ok_or(io::ErrorKind::InvalidData)?.into());
        values.insert("GIT_WORK_TREE".into(),self.directory.to_str().ok_or(io::ErrorKind::InvalidData)?.into());
        if let Some(index)=&self.index{values.insert("GIT_INDEX_FILE".into(),index.directory.join("index").to_str().ok_or(io::ErrorKind::InvalidData)?.into());}
        if let Some(time)=time{for name in["GIT_AUTHOR_DATE","GIT_COMMITTER_DATE"]{values.insert(name.into(),format!("@{} +0000",time/1000));}}
        Ok(values.into_iter().flat_map(|(name,value)|format!("{name}={value}\0").encode_utf16().collect::<Vec<_>>()).chain([0]).collect())
    }
}
impl Index{
    fn current(&self)->io::Result<()>{if self.unknown{return Err(io::ErrorKind::PermissionDenied.into());}self.parent.current()?;private_directory::require_private(&self.root)?;let named=member(&self.parent.file,&self.basename,true)?;
        if no_follow::identity(&self.root)?!=self.identity||no_follow::identity(&named)?!=self.identity||no_follow::final_path(&self.root)?!=self.parent.canonical().join(&self.basename){return Err(io::ErrorKind::PermissionDenied.into());}Ok(())}
    fn describe(&self)->io::Result<String>{self.current()?;Ok(serde_json::to_string(&serde_json::json!({"version":1,"purpose":"fixed-event-private-index",
        "filename":self.directory.join("index"),"directory":self.directory,"identity":no_follow::identity(&self.root)?,"work_authority":false}))?)}
}
fn text(file:&File,limit:u64)->io::Result<String>{let before=no_follow::stamp(file)?;let size=file.metadata()?.len();if size==0||size>limit{return Err(io::ErrorKind::InvalidData.into());}
    let mut source=file.try_clone()?;source.seek(SeekFrom::Start(0))?;let mut bytes=Vec::new();source.take(size+1).read_to_end(&mut bytes)?;
    if bytes.len()as u64!=size||no_follow::stamp(file)?!=before{return Err(io::ErrorKind::PermissionDenied.into());}String::from_utf8(bytes).map_err(io::Error::other)}
fn absolute_member(root:&Path,value:&str)->io::Result<PathBuf>{let named=Path::new(value);if named.is_absolute(){event_git_protocol::validate(&["rev-parse".into(),"HEAD".into()],0,false,None,value,None)?;return Ok(named.to_owned());}
    if value.is_empty()||value.split(['/', '\\']).any(|part|part.is_empty()||part=="."||part==".."||part.contains(':')){return Err(io::ErrorKind::InvalidInput.into());}Ok(root.join(named))}
fn private_child(parent:&LockedPath,name:&str)->io::Result<LockedPath>{match LockedPath::member(parent,&[name],true,false){Ok(value)=>{private_directory::require_private(&value.file)?;Ok(value)},Err(error)if error.kind()==io::ErrorKind::NotFound=>private_new(parent,name),Err(error)=>Err(error)}}
fn private_new(parent:&LockedPath,name:&str)->io::Result<LockedPath>{parent.current()?;let descriptor=Descriptor::current_user()?;let file=no_follow::create_private_child(&parent.file,name,true,descriptor.pointer())?;
    let identity=no_follow::identity(&file)?;private_directory::require_private(&file)?;drop(file);let value=LockedPath::member(parent,&[name],true,false)?;
    if no_follow::identity(&value.file)?!=identity{return Err(io::ErrorKind::PermissionDenied.into());}private_directory::require_private(&value.file)?;Ok(value)}
fn private_new_event(parent:&LockedPath,name:&str)->io::Result<LockedPath>{parent.current()?;let descriptor=Descriptor::current_user()?;let file=no_follow::create_private_child(&parent.file,name,true,descriptor.pointer())?;
    let identity=no_follow::identity(&file)?;private_directory::require_private(&file)?;drop(file);let value=LockedPath::member_event_directory(parent,&[name])?;
    if no_follow::identity(&value.file)?!=identity{return Err(io::ErrorKind::PermissionDenied.into());}private_directory::require_private(&value.file)?;Ok(value)}
fn create_index(parent:&File,name:&str,descriptor:*const std::ffi::c_void)->io::Result<File>{
    use std::os::windows::{ffi::OsStrExt,io::{AsRawHandle,FromRawHandle,OwnedHandle}};
    #[repr(C)]struct Attributes{length:u32,root:isize,name:*const windows_sys::Win32::Foundation::UNICODE_STRING,flags:u32,descriptor:*const std::ffi::c_void,qos:*const std::ffi::c_void}
    crate::no_follow::relative(name)?;
    let mut text=std::ffi::OsStr::new(name).encode_wide().collect::<Vec<_>>();let bytes=u16::try_from(text.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
    let named=windows_sys::Win32::Foundation::UNICODE_STRING{Length:bytes,MaximumLength:bytes,Buffer:text.as_mut_ptr()};
    let attributes=Attributes{length:std::mem::size_of::<Attributes>()as u32,root:parent.as_raw_handle()as isize,name:&named,flags:0x40|0x1000,descriptor,qos:std::ptr::null()};
    let mut status:windows_sys::Win32::System::IO::IO_STATUS_BLOCK=unsafe{std::mem::zeroed()};let mut handle=0;
    // The private index folder needs original DELETE access for exact known GC.
    // The trusted builtin Git publishes index.lock inside this mutable private
    // directory. Permit its parent-directory write handle, while withholding
    // delete sharing so the original directory name cannot be replaced.
    let code=unsafe{NtCreateFile(&mut handle,0x0013_019f,(&raw const attributes).cast(),&mut status,std::ptr::null(),0x80,3,2,1|0x20,std::ptr::null(),0)};
    if code<0{return Err(io::Error::from_raw_os_error(unsafe{windows_sys::Win32::Foundation::RtlNtStatusToDosError(code)}as i32));}
    if handle==0||handle == -1{return Err(io::ErrorKind::InvalidData.into());}
    Ok(File::from(unsafe{OwnedHandle::from_raw_handle(handle as *mut std::ffi::c_void)}))
}
fn random_hex()->io::Result<String>{let mut bytes=[0u8;16];if unsafe{BCryptGenRandom(0,bytes.as_mut_ptr(),16,2)}<0{return Err(io::ErrorKind::Other.into());}Ok(bytes.iter().map(|value|format!("{value:02x}")).collect())}
fn dispose(file:&File)->io::Result<()>{delete_owned(file)}
fn directory_names(file:&File)->io::Result<Vec<String>>{crate::event_worktree::windows_observation::names(file,Instant::now()+Duration::from_secs(30)).map(|values|values.into_iter().map(|(name,_)|name).collect())}
fn allocation(file:&File)->io::Result<u64>{crate::event_worktree::windows_observation::allocation(file)}
fn physical_failure(stage:&'static str,code:i32,stderr:&[u8]){
    let text=String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let reason=if text.contains("permission denied")||text.contains("access is denied"){"access-denied"}
        else if text.contains("unable to create")||text.contains("could not create"){"create-refused"}
        else if text.contains("no such file")||text.contains("cannot find"){"missing-object"}
        else if text.contains("outside repository")||text.contains("not a git repository"){"repository-refused"}
        else{"git-refused"};
    eprintln!("WINDOWS_EVENT_GIT_PHYSICAL_FAILURE stage={stage} exit={code} stderr_bytes={} stderr_sha256={:x} reason={reason}",stderr.len(),Sha256::digest(stderr));
}

fn member(file:&File,name:&str,directory:bool)->io::Result<File>{crate::event_worktree::windows_observation::member(file,name,directory)}
#[link(name="bcrypt")] unsafe extern "system"{fn BCryptGenRandom(algorithm:isize,buffer:*mut u8,length:u32,flags:u32)->i32;}
#[link(name="ntdll")] unsafe extern "system"{fn NtSetInformationFile(file:isize,status:*mut windows_sys::Win32::System::IO::IO_STATUS_BLOCK,information:*const std::ffi::c_void,length:u32,class:u32)->i32;}
#[link(name="ntdll")] unsafe extern "system"{fn NtCreateFile(file:*mut isize,access:u32,attributes:*const std::ffi::c_void,status:*mut windows_sys::Win32::System::IO::IO_STATUS_BLOCK,
    allocation:*const i64,flags:u32,share:u32,disposition:u32,options:u32,ea:*const std::ffi::c_void,ea_length:u32)->i32;}
fn delete_owned(file:&File)->io::Result<()>{
    use std::os::windows::io::AsRawHandle;
    let flags=1u32|2u32|16u32;let mut status:windows_sys::Win32::System::IO::IO_STATUS_BLOCK=unsafe{std::mem::zeroed()};
    let code=unsafe{NtSetInformationFile(file.as_raw_handle()as isize,&mut status,(&raw const flags).cast(),4,64)};
    if code<0{return Err(io::Error::from_raw_os_error(unsafe{windows_sys::Win32::Foundation::RtlNtStatusToDosError(code)}as i32));}Ok(())
}
