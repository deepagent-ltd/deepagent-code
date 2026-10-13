//! A command can only be derived from an original factory and workspace. The
//! request contains recipe values, never executable paths or image identities.
use super::{work_factory::WorkFactory, work_process::{Child,Observation}, work_workspace::Workspace,work_command_phase::Phase};
use super::command_protocol::{self,Image,Input,Isolation,Run,WindowsCpu};
use serde::Deserialize;
use std::{collections::{BTreeMap,BTreeSet},io,sync::Arc};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub version:u8,pub nonce:String,pub work_id:String,pub command_id:String,pub recipe_hash:String,pub control_revision:u64,
    pub argv:Vec<String>,pub cwd:Option<String>,pub env:BTreeMap<String,String>,pub inputs:Vec<String>,pub outputs:Vec<String>,
    pub cpu:WindowsCpu,pub job_commit_max_bytes:u64,pub timeout_ms:u64,pub stdout_bytes:u64,pub stderr_bytes:u64,
}
pub(super) struct Command { child:Child,nonce:String,continued:bool,cancelled:bool,ready:bool,terminal:bool,
    phase:Arc<Phase>,binding:serde_json::Value,inventory:serde_json::Value,
    known_stop:bool,retired:bool,pending:Vec<u8>,frames:Vec<Vec<u8>>,observed:u64 }
impl Command {
    pub(super) fn launch(factory:&WorkFactory,workspace:&mut Workspace,request:Request)->io::Result<Self>{
        let(directory,identity)=workspace.command_location()?;
        let inventory=workspace.observe_inventory()?;
        let selected=request.inputs.iter().chain(&request.outputs).collect::<BTreeSet<_>>();
        if selected.len()!=request.inputs.len()+request.outputs.len()||selected.len()!=inventory.files.len()||
            inventory.files.iter().any(|file|!selected.contains(&file.relative)){
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let image=|value:&crate::native_windows::image_factory::Image|{
            let value=value.description();Image{path:value.path.to_string_lossy().into_owned(),mount_path:None,
                identity:value.identity.clone(),sha256:value.sha256.clone(),bytes:value.bytes}
        };
        let inputs=request.inputs.iter().map(|relative|{
            let file=inventory.files.iter().find(|file|&file.relative==relative).ok_or(io::ErrorKind::PermissionDenied)?;
            Ok(Input{relative:relative.clone(),identity:file.identity.clone(),sha256:file.sha256.clone(),bytes:file.bytes})
        }).collect::<io::Result<Vec<_>>>()?;
        if request.outputs.iter().any(|relative|inventory.files.iter().find(|file|&file.relative==relative).is_none_or(|file|file.bytes!=0)){
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let run=Run{version:request.version,nonce:request.nonce.clone(),work_id:request.work_id,command_id:request.command_id,
            recipe_hash:request.recipe_hash,control_revision:request.control_revision,workspace:directory.to_string_lossy().into_owned(),
            workspace_identity:identity,executable:image(factory.factory().payload()),argv:request.argv,cwd:request.cwd,env:request.env,
            inputs,outputs:request.outputs,isolation:Isolation::Windows{cpu:request.cpu,job_commit_max_bytes:request.job_commit_max_bytes,
                job_processes_max:1,runtime_files:factory.factory().libraries().iter().map(image).collect()},
            timeout_ms:request.timeout_ms,stdout_bytes:request.stdout_bytes,stderr_bytes:request.stderr_bytes};
        run.validate()?;factory.factory().current()?;workspace.current()?;
        let frame=frame(&run)?;
        // These are original held Workspace observations, captured before any
        // ACL grant. A Host JSON record cannot supply or renew these facts.
        let inventory=serde_json::to_value(inventory).map_err(io::Error::other)?;
        let binding=serde_json::json!({"nonce":run.nonce,"work_id":run.work_id,"command_id":run.command_id,
            "recipe_hash":run.recipe_hash,"control_revision":run.control_revision});
        if serde_json::to_vec(&inventory).map_err(io::Error::other)?.len()>65_536{return Err(io::ErrorKind::InvalidData.into());}
        let phase=Phase::capture(workspace,&run.nonce,&request.inputs,&run.outputs)?;
        let child=Child::launch_supervisor(factory).inspect_err(|_|phase.unknown())?;
        if let Err(error)=child.write(frame){phase.unknown();if let Err(child)=child.retire(){std::mem::forget(child);}return Err(error);}
        Ok(Self{child,nonce:request.nonce,continued:false,cancelled:false,ready:false,terminal:false,phase,binding,inventory,known_stop:false,retired:false,pending:Vec::new(),frames:Vec::new(),observed:0})
    }
    pub(super) fn id(&self)->u32{self.child.id()}
    pub(super) fn control(&mut self,action:&str)->io::Result<()>{
        match action{
            "continue" if self.ready&&!self.continued&&!self.cancelled&&!self.terminal=>{self.phase.running()?;self.child.write(frame(&serde_json::json!({"version":2,"nonce":self.nonce,"action":"continue"}))?).inspect_err(|_|self.phase.unknown())?;self.continued=true;Ok(())},
            "cancel" if self.cancelled||self.terminal=>Ok(()),
            "cancel"=>{self.child.write(frame(&serde_json::json!({"version":2,"nonce":self.nonce,"action":"cancel"}))?)?;self.cancelled=true;Ok(())},
            _=>Err(io::ErrorKind::PermissionDenied.into()),
        }
    }
    pub(super) fn read(&mut self)->io::Result<Observation>{
        if !self.frames.is_empty(){return Ok(Observation{kind:"stdout",bytes:self.frames.remove(0),exit_code:None});}
        let observed=self.child.read()?;
        if observed.kind=="exit"&&!self.retired{
            if self.known_stop&&observed.exit_code==Some(0){self.phase.retired()?;}else{self.phase.unknown();}
            self.retired=true;
        }
        if observed.kind!="stdout"{return Ok(observed);}
        self.observed=self.observed.checked_add(observed.bytes.len()as u64).filter(|value|*value<=8_388_608).ok_or(io::ErrorKind::InvalidData)?;
        self.pending.extend_from_slice(&observed.bytes);
        while self.pending.len()>=4{
            let size=u32::from_be_bytes(self.pending[..4].try_into().map_err(|_|io::ErrorKind::InvalidData)?)as usize;
            if size==0||size>command_protocol::FRAME_BYTES{return Err(io::ErrorKind::InvalidData.into());}
            if self.pending.len()<size+4{break;}
            let event:serde_json::Value=serde_json::from_slice(&self.pending[4..size+4]).map_err(io::Error::other)?;
            if event.get("nonce").and_then(serde_json::Value::as_str)!=Some(self.nonce.as_str())||event.get("version").and_then(serde_json::Value::as_u64)!=Some(2){return Err(io::ErrorKind::PermissionDenied.into());}
            match event.get("kind").and_then(serde_json::Value::as_str){
                Some("ready") if !self.ready&&!self.terminal=>{self.phase.ready()?;self.ready=true;},
                Some("data") if self.continued&&!self.terminal=>{},
                Some("stopped") if self.ready&&!self.terminal=>{
                    self.known_stop=event.get("root_exit").and_then(serde_json::Value::as_bool)==Some(true)&&event.get("tree_empty").and_then(serde_json::Value::as_bool)==Some(true)&&
                        event.pointer("/stdout/eof").and_then(serde_json::Value::as_bool)==Some(true)&&event.pointer("/stderr/eof").and_then(serde_json::Value::as_bool)==Some(true);
                    if !self.known_stop{self.phase.unknown();return Err(io::ErrorKind::PermissionDenied.into());}self.terminal=true;
                },
                Some("unavailable") if !self.terminal=>{self.phase.unknown();self.terminal=true;},
                _=>return Err(io::ErrorKind::PermissionDenied.into()),
            }
            self.frames.push(self.pending.drain(..size+4).collect());
            if self.frames.len()>16{return Err(io::ErrorKind::WouldBlock.into());}
        }
        if self.pending.len()>command_protocol::FRAME_BYTES+4{return Err(io::ErrorKind::InvalidData.into());}
        Ok(if self.frames.is_empty(){Observation{kind:"idle",bytes:Vec::new(),exit_code:None}}else{Observation{kind:"stdout",bytes:self.frames.remove(0),exit_code:None}})
    }
    pub(super) fn description(&self)->serde_json::Value{
        let mut value=self.phase.description();
        value["binding"]=self.binding.clone();value["inventory"]=self.inventory.clone();
        value["jobRetired"]=serde_json::json!(self.retired&&self.known_stop);
        value["appContainerRetired"]=serde_json::json!(self.retired&&self.known_stop&&value["phase"]=="retired");
        value["aclRestored"]=value["appContainerRetired"].clone();value
    }
    pub(super) fn close(&mut self)->io::Result<bool>{
        if !self.frames.is_empty()||!self.pending.is_empty(){return Ok(false);}
        self.child.close()
    }
    pub(super) fn retire(mut self)->Result<(),Self>{
        if !self.terminal{let _=self.control("cancel");}
        let start=std::time::Instant::now();
        while start.elapsed()<std::time::Duration::from_secs(5){
            match self.read(){Ok(observed)if observed.kind=="exit"=>return Ok(()),Ok(_)=>{},Err(_)=>break}
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        self.phase.unknown();let _=self.child.stop();
        if self.child.close().ok()==Some(true){return Ok(());}Err(self)
    }
}
fn frame(value:&impl serde::Serialize)->io::Result<Vec<u8>>{
    let bytes=serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.is_empty()||bytes.len()>command_protocol::FRAME_BYTES{return Err(io::ErrorKind::InvalidData.into());}
    Ok([&(bytes.len()as u32).to_be_bytes()[..],&bytes].concat())
}
