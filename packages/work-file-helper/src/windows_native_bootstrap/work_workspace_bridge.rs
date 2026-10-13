//! Workspace Externals remain tied to the original capture and fixed Work factory.
//! JSON describes bounded inventory; neither paths nor stored metadata mint a lease.
use super::{napi,work_bridge::{self,Api},work_workspace::{Workspace,Open,ReadOutput,Cleanup}};
use std::{collections::HashMap,ffi::c_void,io,ptr,sync::{Mutex,OnceLock}};
type Env=*mut c_void;type Value=*mut c_void;type Callback=unsafe extern "C" fn(Env,*mut c_void)->Value;
struct Entry{capture:usize,factory:usize,reference:usize,workspace:Workspace}
struct State{entries:HashMap<usize,Entry>,pending:usize}
static STATES:OnceLock<Mutex<HashMap<usize,State>>>=OnceLock::new();
fn states()->&'static Mutex<HashMap<usize,State>>{STATES.get_or_init(||Mutex::new(HashMap::new()))}
pub(super) fn register(env:Env,exports:Value)->io::Result<()>{
    let api=Api::load()?;let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)){return Err(io::ErrorKind::PermissionDenied.into());}
    all.insert(env as usize,State{entries:HashMap::new(),pending:0});drop(all);
    if unsafe{(api.cleanup)(env,cleanup,env)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    for(name,callback)in[(c"openWorkWorkspace",open as Callback),(c"currentWorkWorkspace",current as Callback),
        (c"readWorkWorkspaceOutput",read as Callback),(c"cleanupWorkWorkspace",collect as Callback),(c"closeWorkWorkspace",close as Callback)]{
        let mut value=ptr::null_mut();if unsafe{(api.create_function)(env,name.as_ptr(),name.to_bytes().len(),callback,ptr::null_mut(),&mut value)}!=0||
            unsafe{(api.set_property)(env,exports,name.as_ptr(),value)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    }Ok(())
}
fn args(api:&Api,env:Env,info:*mut c_void,expected:usize)->io::Result<[Value;4]>{
    let mut count=4;let mut args=[ptr::null_mut();4];
    if unsafe{(api.get_cb_info)(env,info,&mut count,args.as_mut_ptr(),ptr::null_mut(),ptr::null_mut())}!=0||count!=expected||
        !napi::same_capture(env,args[0]){return Err(io::ErrorKind::PermissionDenied.into());}Ok(args)
}
unsafe extern "C" fn open(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{
        let args=args(&api,env,info,3)?;let capture=api.pointer(env,args[0])?;let factory=api.pointer(env,args[1])?;
        let request:Open=serde_json::from_str(&api.string(env,args[2])?).map_err(io::Error::other)?;
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if state.entries.len()+state.pending>=8{return Err(io::ErrorKind::WouldBlock.into());}state.pending+=1;drop(all);
        let workspace=work_bridge::with_factory(env,args[0],args[1],|_|Workspace::open(request));
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;state.pending-=1;
        let workspace=workspace?;let metadata=api.text(env,&workspace.description()?)?;let mut reference=ptr::null_mut();
        if unsafe{(api.create_reference)(env,args[1],1,&mut reference)}!=0||reference.is_null(){return Err(io::ErrorKind::Unsupported.into());}
        let token=Box::into_raw(Box::new(env as usize));let mut external=ptr::null_mut();
        if unsafe{(api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut external)}!=0{
            unsafe{drop(Box::from_raw(token));(api.delete_reference)(env,reference);}return Err(io::ErrorKind::Unsupported.into());}
        state.entries.insert(token as usize,Entry{capture,factory,reference:reference as usize,workspace});
        let mut object=ptr::null_mut();if unsafe{(api.create_object)(env,&mut object)}!=0||
            unsafe{(api.set_property)(env,object,c"lease".as_ptr(),external)}!=0||unsafe{(api.set_property)(env,object,c"metadata".as_ptr(),metadata)}!=0{
            return Err(io::ErrorKind::Unsupported.into());}Ok(object)
    })();result.unwrap_or_else(|error|failure(&api,env,"open",error))
}
fn with_workspace<A>(api:&Api,env:Env,args:&[Value;4],run:impl FnOnce(&mut Workspace)->io::Result<A>)->io::Result<A>{
    work_bridge::with_factory(env,args[0],args[1],|_|Ok(()))?;
    let token=api.pointer(env,args[2])?;let capture=api.pointer(env,args[0])?;let factory=api.pointer(env,args[1])?;
    // Lookup the original registry before any External pointer dereference. Tokens never carry authority.
    let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let entry=all.get_mut(&(env as usize)).and_then(|state|state.entries.get_mut(&token)).ok_or(io::ErrorKind::PermissionDenied)?;
    if entry.capture!=capture||entry.factory!=factory{return Err(io::ErrorKind::PermissionDenied.into());}run(&mut entry.workspace)
}
unsafe extern "C" fn current(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
        let metadata=with_workspace(&api,env,&args,|workspace|workspace.description())?;api.text(env,&metadata)})();
    result.unwrap_or_else(|error|failure(&api,env,"current",error))
}
unsafe extern "C" fn read(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,4)?;
        let request:ReadOutput=serde_json::from_str(&api.string(env,args[3])?).map_err(io::Error::other)?;
        let(metadata,bytes)=with_workspace(&api,env,&args,|workspace|workspace.read_output(request))?;
        let metadata=api.text(env,&metadata)?;let mut payload=ptr::null_mut();let mut object=ptr::null_mut();
        if unsafe{(api.buffer_copy)(env,bytes.len(),bytes.as_ptr().cast(),ptr::null_mut(),&mut payload)}!=0||unsafe{(api.create_object)(env,&mut object)}!=0||
            unsafe{(api.set_property)(env,object,c"metadata".as_ptr(),metadata)}!=0||unsafe{(api.set_property)(env,object,c"bytes".as_ptr(),payload)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok(object)})();
    result.unwrap_or_else(|error|failure(&api,env,"read",error))
}
unsafe extern "C" fn collect(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,4)?;
        let request:Cleanup=serde_json::from_str(&api.string(env,args[3])?).map_err(io::Error::other)?;
        let metadata=with_workspace(&api,env,&args,|workspace|workspace.cleanup(request))?;api.text(env,&metadata)})();
    result.unwrap_or_else(|error|failure(&api,env,"cleanup",error))
}
unsafe extern "C" fn close(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
        let capture=api.pointer(env,args[0])?;let factory=api.pointer(env,args[1])?;let token=api.pointer(env,args[2])?;
        if !super::work_command_bridge::workspace_can_close(env,token)?{return Err(io::ErrorKind::WouldBlock.into());}
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        let entry=state.entries.get(&token).ok_or(io::ErrorKind::PermissionDenied)?;
        if entry.capture!=capture||entry.factory!=factory{return Err(io::ErrorKind::PermissionDenied.into());}
        let entry=state.entries.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?;drop(entry.workspace);drop(all);
        unsafe{(api.delete_reference)(env,entry.reference as *mut c_void);}undefined(&api,env)})();
    result.unwrap_or_else(|error|failure(&api,env,"close",error))
}
pub(super) fn with_original<A>(env:Env,capture:usize,factory:usize,token:usize,run:impl FnOnce(&mut Workspace)->io::Result<A>)->io::Result<A>{
    let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let entry=all.get_mut(&(env as usize)).and_then(|state|state.entries.get_mut(&token)).ok_or(io::ErrorKind::PermissionDenied)?;
    if entry.capture!=capture||entry.factory!=factory{return Err(io::ErrorKind::PermissionDenied.into());}run(&mut entry.workspace)
}
pub(super) fn factory_can_close(env:Env,factory:usize)->io::Result<bool>{
    let all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    Ok(all.get(&(env as usize)).is_none_or(|state|state.pending==0&&!state.entries.values().any(|entry|entry.factory==factory)))
}
fn undefined(api:&Api,env:Env)->io::Result<Value>{let mut value=ptr::null_mut();if unsafe{(api.undefined)(env,&mut value)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok(value)}
fn failure(api:&Api,env:Env,stage:&'static str,error:io::Error)->Value{eprintln!("WINDOWS_WORK_WORKSPACE_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));api.error(env,c"WINDOWS_WORK_WORKSPACE_UNAVAILABLE")}
unsafe extern "C" fn finalize(env:Env,token:*mut c_void,_:*mut c_void){
    if token.is_null(){return;}let removed=states().lock().ok().and_then(|mut all|all.get_mut(&(env as usize)).and_then(|state|state.entries.remove(&(token as usize))));
    if let Some(entry)=removed{drop(entry.workspace);if let Ok(api)=Api::load(){unsafe{(api.delete_reference)(env,entry.reference as *mut c_void);}}}unsafe{drop(Box::from_raw(token.cast::<usize>()));}
}
unsafe extern "C" fn cleanup(env:*mut c_void){let Ok(mut all)=states().lock()else{return;};let Some(state)=all.remove(&(env as usize))else{return;};drop(state);}
