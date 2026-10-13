//! Optional builtin Git ports. Externals select only original registry objects.
//! Repository/index mutation is separate from observation-only directory leases.
use super::{event_git::Git,event_git_namespace::{self,Repository},napi,work_bridge::{self,Api}};
use crate::{no_follow::{self,LockedPath},protocol::Identity};
use serde::Deserialize;
use std::{collections::HashMap,ffi::c_void,io,ptr,sync::{Mutex,OnceLock}};
type Env=*mut c_void;type Value=*mut c_void;type Callback=unsafe extern "C" fn(Env,*mut c_void)->Value;
struct Original{capture:usize,factory:usize,reference:usize}
struct Runtime{original:Original,git:std::sync::Arc<Git>}
struct Repo{original:Original,runtime:usize,repository:Repository}
struct Directory{original:Original,directory:String,held:LockedPath,identity:Identity}
struct State{runtimes:HashMap<usize,Runtime>,repos:HashMap<usize,Repo>,directories:HashMap<usize,Directory>,pending:usize}
static STATES:OnceLock<Mutex<HashMap<usize,State>>>=OnceLock::new();
fn states()->&'static Mutex<HashMap<usize,State>>{STATES.get_or_init(||Mutex::new(HashMap::new()))}
pub(super) fn register(env:Env,exports:Value)->io::Result<()>{
    let api=Api::load()?;let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)){return Err(io::ErrorKind::PermissionDenied.into());}
    all.insert(env as usize,State{runtimes:HashMap::new(),repos:HashMap::new(),directories:HashMap::new(),pending:0});drop(all);
    if unsafe{(api.cleanup)(env,cleanup,env)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    for(name,callback)in[(c"openEventGit",open_runtime as Callback),(c"currentEventGit",current_runtime as Callback),(c"closeEventGit",close_runtime as Callback),
        (c"openEventGitRepository",open_repo as Callback),(c"currentEventGitRepository",current_repo as Callback),(c"closeEventGitRepository",close_repo as Callback),
        (c"runEventGit",run as Callback),(c"prepareEventGitParent",prepare_parent as Callback),(c"openEventGitIndex",open_index as Callback),(c"eventGitIndexAllocation",index_allocation as Callback),(c"closeEventGitIndex",close_index as Callback),
        (c"openEventDirectory",open_directory as Callback),(c"currentEventDirectory",current_directory as Callback),(c"closeEventDirectory",close_directory as Callback)]{
        let mut value=ptr::null_mut();if unsafe{(api.create_function)(env,name.as_ptr(),name.to_bytes().len(),callback,ptr::null_mut(),&mut value)}!=0||
            unsafe{(api.set_property)(env,exports,name.as_ptr(),value)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    }Ok(())
}
fn args(api:&Api,env:Env,info:*mut c_void,expected:usize)->io::Result<[Value;5]>{let mut count=5;let mut args=[ptr::null_mut();5];
    if unsafe{(api.get_cb_info)(env,info,&mut count,args.as_mut_ptr(),ptr::null_mut(),ptr::null_mut())}!=0||count!=expected||!napi::same_capture(env,args[0]){
        return Err(io::ErrorKind::PermissionDenied.into());}Ok(args)}
fn original(api:&Api,env:Env,args:&[Value;5],reference_to:Value)->io::Result<Original>{let mut reference=ptr::null_mut();
    if unsafe{(api.create_reference)(env,reference_to,1,&mut reference)}!=0||reference.is_null(){return Err(io::ErrorKind::Unsupported.into());}
    Ok(Original{capture:api.pointer(env,args[0])?,factory:api.pointer(env,args[1])?,reference:reference as usize})}

fn matches(api:&Api,env:Env,args:&[Value;5],original:&Original)->io::Result<()>{if original.capture!=api.pointer(env,args[0])?||original.factory!=api.pointer(env,args[1])?{return Err(io::ErrorKind::PermissionDenied.into());}Ok(())}
fn external(api:&Api,env:Env,metadata:&str)->io::Result<(usize,Value)>{let token=Box::into_raw(Box::new(env as usize));let mut value=ptr::null_mut();
    if unsafe{(api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut value)}!=0{unsafe{drop(Box::from_raw(token));}return Err(io::ErrorKind::Unsupported.into());}
    let mut object=ptr::null_mut();if unsafe{(api.create_object)(env,&mut object)}!=0||unsafe{(api.set_property)(env,object,c"lease".as_ptr(),value)}!=0||
        unsafe{(api.set_property)(env,object,c"metadata".as_ptr(),api.text(env,metadata)?)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok((token as usize,object))}
unsafe extern "C" fn open_runtime(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{let args=args(&api,env,info,2)?;
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if state.runtimes.len()+state.pending>=64{return Err(io::ErrorKind::WouldBlock.into());}state.pending+=1;drop(all);
        let git=work_bridge::with_original_factory(env,args[0],args[1],|image,proof,factory|factory.event_git(image,proof));
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;state.pending-=1;
        let git=git?;let metadata=git.describe()?;let owned=original(&api,env,&args,args[1])?;let(token,value)=external(&api,env,metadata)?;
        state.runtimes.insert(token,Runtime{original:owned,git});Ok(value)})();result.unwrap_or_else(|error|failure(&api,env,"open_runtime",error))}
unsafe extern "C" fn current_runtime(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;work_bridge::with_factory(env,args[0],args[1],|_|Ok(()))?;
        let all=states().lock().map_err(|_|io::ErrorKind::Other)?;let runtime=all.get(&(env as usize)).and_then(|state|state.runtimes.get(&api.pointer(env,args[2]).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
        matches(&api,env,&args,&runtime.original)?;api.text(env,runtime.git.describe()?)})();result.unwrap_or_else(|error|failure(&api,env,"current_runtime",error))}
unsafe extern "C" fn open_repo(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{let args=args(&api,env,info,4)?;let request:event_git_namespace::Open=serde_json::from_str(&api.string(env,args[3])?).map_err(io::Error::other)?;
        work_bridge::with_factory(env,args[0],args[1],|_|Ok(()))?;let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
        let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;if state.repos.len()+state.pending>=64{return Err(io::ErrorKind::WouldBlock.into());}
        let runtime_token=api.pointer(env,args[2])?;let runtime=state.runtimes.get(&runtime_token).ok_or(io::ErrorKind::PermissionDenied)?;
        matches(&api,env,&args,&runtime.original)?;runtime.git.current()?;
        let repository=Repository::open(request)?;let metadata=repository.describe(&runtime.git)?;let owned=original(&api,env,&args,args[2])?;
        let(token,value)=external(&api,env,&metadata)?;state.repos.insert(token,Repo{original:owned,runtime:runtime_token,repository});Ok(value)
    })();result.unwrap_or_else(|error|failure(&api,env,"open_repository",error))}
fn with_repo<A>(api:&Api,env:Env,args:&[Value;5],run:impl FnOnce(&super::work_factory::WorkFactory,&Git,&mut Repository)->io::Result<A>)->io::Result<A>{
    work_bridge::with_factory(env,args[0],args[1],|factory|{
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        let token=api.pointer(env,args[2])?;let entry=state.repos.get_mut(&token).ok_or(io::ErrorKind::PermissionDenied)?;matches(api,env,args,&entry.original)?;
        let runtime=state.runtimes.get(&entry.runtime).ok_or(io::ErrorKind::PermissionDenied)?;matches(api,env,args,&runtime.original)?;
        run(factory,&runtime.git,&mut entry.repository)
    })
}
unsafe extern "C" fn current_repo(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    let metadata=with_repo(&api,env,&args,|_,git,repo|repo.describe(git))?;api.text(env,&metadata)})();result.unwrap_or_else(|error|failure(&api,env,"current_repository",error))}
unsafe extern "C" fn run(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,5)?;
    let request:event_git_namespace::Run=serde_json::from_str(&api.string(env,args[3])?).map_err(io::Error::other)?;let mut data=ptr::null_mut();let mut bytes=0;
    if unsafe{(api.buffer_info)(env,args[4],&mut data,&mut bytes)}!=0||bytes>16_777_216||bytes>0&&data.is_null(){return Err(io::ErrorKind::InvalidData.into());}
    let input=if bytes==0{&[]}else{unsafe{std::slice::from_raw_parts(data.cast::<u8>(),bytes)}};
    let result=with_repo(&api,env,&args,|factory,git,repo|repo.run(factory,git,request,input))?;
    let mut object=ptr::null_mut();if unsafe{(api.create_object)(env,&mut object)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    let metadata=api.text(env,&serde_json::to_string(&serde_json::json!({"version":1,"purpose":"fixed-event-git-result","exit_code":result.code,
        "tree_retired":true,"dual_eof":true,"writer_joined":true,"work_authority":false}))?)?;
    if unsafe{(api.set_property)(env,object,c"metadata".as_ptr(),metadata)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    for(name,bytes)in[(c"stdout",result.stdout),(c"stderr",result.stderr)]{let mut buffer=ptr::null_mut();if unsafe{(api.buffer_copy)(env,bytes.len(),bytes.as_ptr().cast(),ptr::null_mut(),&mut buffer)}!=0||
        unsafe{(api.set_property)(env,object,name.as_ptr(),buffer)}!=0{return Err(io::ErrorKind::Unsupported.into());}}Ok(object)
    })();result.unwrap_or_else(|error|failure(&api,env,"run",error))}
unsafe extern "C" fn open_index(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    let metadata=with_repo(&api,env,&args,|factory,_,repo|repo.open_index(factory))?;api.text(env,&metadata)})();result.unwrap_or_else(|error|failure(&api,env,"open_index",error))}
unsafe extern "C" fn index_allocation(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    let bytes=with_repo(&api,env,&args,|_,_,repo|repo.index_allocation())?;api.text(env,&serde_json::to_string(&serde_json::json!({"version":1,"allocated_bytes":bytes}))?)})();result.unwrap_or_else(|error|failure(&api,env,"index_allocation",error))}
unsafe extern "C" fn close_index(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    with_repo(&api,env,&args,|_,_,repo|repo.close_index())?;undefined(&api,env)})();result.unwrap_or_else(|error|failure(&api,env,"close_index",error))}
#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct ObserveDirectory{directory:String,expected:Identity}
unsafe extern "C" fn prepare_parent(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    let value=with_repo(&api,env,&args,|factory,_,repository|repository.prepare_parent(factory))?;api.text(env,&value)
    })();result.unwrap_or_else(|error|failure(&api,env,"prepare_parent",error))}
unsafe extern "C" fn open_directory(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    let request:ObserveDirectory=serde_json::from_str(&api.string(env,args[2])?).map_err(io::Error::other)?;
    let held=work_bridge::with_factory(env,args[0],args[1],|_|LockedPath::open_event_directory(std::path::Path::new(&request.directory)))?;
    if no_follow::identity(&held.file)?!=request.expected{return Err(io::ErrorKind::PermissionDenied.into());}
    let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
    if state.directories.len()+state.pending>=128{return Err(io::ErrorKind::WouldBlock.into());}
    let owned=original(&api,env,&args,args[1])?;let value=Directory{original:owned,directory:request.directory,held,identity:request.expected};
    let metadata=directory_metadata(&value)?;let(token,result)=external(&api,env,&metadata)?;state.directories.insert(token,value);Ok(result)
    })();result.unwrap_or_else(|error|failure(&api,env,"open_directory",error))}
unsafe extern "C" fn current_directory(env:Env,info:*mut c_void)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    work_bridge::with_factory(env,args[0],args[1],|_|Ok(()))?;let all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    let value=all.get(&(env as usize)).and_then(|state|state.directories.get(&api.pointer(env,args[2]).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
    matches(&api,env,&args,&value.original)?;api.text(env,&directory_metadata(value)?)})();result.unwrap_or_else(|error|failure(&api,env,"current_directory",error))}
fn directory_metadata(value:&Directory)->io::Result<String>{value.held.current()?;if no_follow::identity(&value.held.file)?!=value.identity{return Err(io::ErrorKind::PermissionDenied.into());}
    Ok(serde_json::to_string(&serde_json::json!({"version":1,"purpose":"event-namespace-observation","directory":value.directory,"identity":value.identity,"work_authority":false}))?)}
unsafe extern "C" fn close_runtime(env:Env,info:*mut c_void)->Value{close_kind(env,info,0)}
unsafe extern "C" fn close_repo(env:Env,info:*mut c_void)->Value{close_kind(env,info,1)}
unsafe extern "C" fn close_directory(env:Env,info:*mut c_void)->Value{close_kind(env,info,2)}
fn close_kind(env:Env,info:*mut c_void,kind:u8)->Value{let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
    let token=api.pointer(env,args[2])?;let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
    let owned=if kind==1 {let repo=state.repos.get(&token).ok_or(io::ErrorKind::PermissionDenied)?;matches(&api,env,&args,&repo.original)?;if !repo.repository.can_close(){return Err(io::ErrorKind::WouldBlock.into());}
        state.repos.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?.original
    }else if kind==0 {let runtime=state.runtimes.get(&token).ok_or(io::ErrorKind::PermissionDenied)?;matches(&api,env,&args,&runtime.original)?;if state.repos.values().any(|repo|repo.runtime==token){return Err(io::ErrorKind::WouldBlock.into());}
        state.runtimes.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?.original
    }else if kind==2 {let value=state.directories.get(&token).ok_or(io::ErrorKind::PermissionDenied)?;matches(&api,env,&args,&value.original)?;state.directories.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?.original
    }else{return Err(io::ErrorKind::PermissionDenied.into());};drop(all);unsafe{(api.delete_reference)(env,owned.reference as *mut c_void);}undefined(&api,env)
    })();result.unwrap_or_else(|error|failure(&api,env,"close",error))}
pub(super) fn factory_can_close(env:Env,factory:usize)->io::Result<bool>{let all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    Ok(all.get(&(env as usize)).is_none_or(|state|state.pending==0&&!state.runtimes.values().any(|value|value.original.factory==factory)&&
        !state.repos.values().any(|value|value.original.factory==factory)&&!state.directories.values().any(|value|value.original.factory==factory)))}
fn undefined(api:&Api,env:Env)->io::Result<Value>{let mut value=ptr::null_mut();if unsafe{(api.undefined)(env,&mut value)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok(value)}
fn failure(api:&Api,env:Env,stage:&'static str,error:io::Error)->Value{eprintln!("WINDOWS_EVENT_GIT_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));api.error(env,if error.to_string()=="EVENT_GIT_PHYSICAL_UNKNOWN"{c"WINDOWS_EVENT_GIT_UNKNOWN"}else{c"WINDOWS_EVENT_GIT_UNAVAILABLE"})}
unsafe extern "C" fn finalize(env:Env,token:*mut c_void,_:*mut c_void){if token.is_null(){return;}let Ok(mut all)=states().lock()else{return;};let Some(state)=all.get_mut(&(env as usize))else{return;};let key=token as usize;
    if state.repos.get(&key).is_some_and(|repo|!repo.repository.can_close())||state.repos.values().any(|repo|repo.runtime==key){return;}
    let original=state.repos.remove(&key).map(|value|value.original).or_else(||state.runtimes.remove(&key).map(|value|value.original)).or_else(||state.directories.remove(&key).map(|value|value.original));drop(all);
    if let Some(original)=original{if let Ok(api)=Api::load(){unsafe{(api.delete_reference)(env,original.reference as *mut c_void);}}}unsafe{drop(Box::from_raw(token.cast::<usize>()));}}
unsafe extern "C" fn cleanup(env:*mut c_void){if let Ok(mut all)=states().lock(){if let Some(state)=all.remove(&(env as usize)){
    // Unknown jobs retain every original Git image, repository and reference
    // graph. Dropping just the repo would release the running child's images.
    if state.repos.values().any(|repo|!repo.repository.can_close()) { std::mem::forget(state); }
}}}
