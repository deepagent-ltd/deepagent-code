//! Child Externals are tied to the exact original capture and Work factory.
//! Retired roots may only observe, stop or close their already-owned children.
use super::{napi, work_bridge::{self,Api},work_process::Observation,work_command::{Command,Request},work_workspace_bridge};
use std::{collections::HashMap,ffi::c_void,io,ptr,sync::{Mutex,OnceLock}};
type Env=*mut c_void;
type Value=*mut c_void;
type Callback=unsafe extern "C" fn(Env,*mut c_void)->Value;
struct Entry{capture:usize,factory:usize,factory_reference:usize,workspace:usize,workspace_reference:usize,child:Command}
struct State{entries:HashMap<usize,Entry>,blocked:std::collections::HashSet<usize>,pending:usize}
static STATES:OnceLock<Mutex<HashMap<usize,State>>>=OnceLock::new();
fn states()->&'static Mutex<HashMap<usize,State>>{STATES.get_or_init(||Mutex::new(HashMap::new()))}
pub(super) fn register(env:Env,exports:Value)->io::Result<()>{
    let api=Api::load()?; let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)){return Err(io::ErrorKind::PermissionDenied.into());}
    all.insert(env as usize,State{entries:HashMap::new(),blocked:std::collections::HashSet::new(),pending:0});drop(all);
    if unsafe{(api.cleanup)(env,cleanup,env)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    for(name,callback)in[(c"launchWorkCommand",launch as Callback),(c"controlWorkCommand",write as Callback),
        (c"readWorkCommand",read as Callback),(c"describeWorkCommand",describe as Callback),(c"cancelWorkCommand",stop as Callback),(c"closeWorkCommand",close as Callback)]{
        let mut value=ptr::null_mut();
        if unsafe{(api.create_function)(env,name.as_ptr(),name.to_bytes().len(),callback,ptr::null_mut(),&mut value)}!=0||
            unsafe{(api.set_property)(env,exports,name.as_ptr(),value)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    }Ok(())
}
fn args(api:&Api,env:Env,info:*mut c_void,expected:usize)->io::Result<[Value;4]>{
    let mut count=4;let mut args=[ptr::null_mut();4];
    if unsafe{(api.get_cb_info)(env,info,&mut count,args.as_mut_ptr(),ptr::null_mut(),ptr::null_mut())}!=0||count!=expected||
        !napi::same_capture(env,args[0]){return Err(io::ErrorKind::PermissionDenied.into());}Ok(args)
}
unsafe extern "C" fn launch(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{
        let args=args(&api,env,info,4)?;let factory=api.pointer(env,args[1])?;let capture=api.pointer(env,args[0])?;let workspace=api.pointer(env,args[2])?;
        let request:Request=serde_json::from_str(&api.string(env,args[3])?).map_err(io::Error::other)?;
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
        let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if state.entries.len()+state.pending>=8||state.blocked.contains(&factory){return Err(io::ErrorKind::WouldBlock.into());}
        state.pending+=1;drop(all);
        let child=work_bridge::with_factory(env,args[0],args[1],|factory|work_workspace_bridge::with_original(env,capture,api.pointer(env,args[1])?,workspace,|workspace|Command::launch(factory,workspace,request)));
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
        let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;state.pending-=1;
        let child=match child{Ok(child)=>child,Err(error)=>{state.blocked.insert(factory);return Err(error);}};
        let pid=child.id();let mut reference=ptr::null_mut();
        if unsafe{(api.create_reference)(env,args[1],1,&mut reference)}!=0||reference.is_null(){retain(child);state.blocked.insert(factory);return Err(io::ErrorKind::Unsupported.into());}
        let mut workspace_reference=ptr::null_mut();
        if unsafe{(api.create_reference)(env,args[2],1,&mut workspace_reference)}!=0||workspace_reference.is_null(){retain(child);state.blocked.insert(factory);return Err(io::ErrorKind::Unsupported.into());}
        let token=Box::into_raw(Box::new(env as usize));let mut external=ptr::null_mut();
        if unsafe{(api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut external)}!=0{
            retain(child);state.blocked.insert(factory);unsafe{drop(Box::from_raw(token));(api.delete_reference)(env,reference);(api.delete_reference)(env,workspace_reference);}return Err(io::ErrorKind::Unsupported.into());
        }
        state.entries.insert(token as usize,Entry{capture:api.pointer(env,args[0])?,factory,factory_reference:reference as usize,workspace,workspace_reference:workspace_reference as usize,child});
        let mut object=ptr::null_mut();let mut id=ptr::null_mut();
        if unsafe{(api.create_object)(env,&mut object)}!=0||unsafe{(api.create_uint)(env,pid,&mut id)}!=0||
            unsafe{(api.set_property)(env,object,c"lease".as_ptr(),external)}!=0||unsafe{(api.set_property)(env,object,c"pid".as_ptr(),id)}!=0{
            return Err(io::ErrorKind::Unsupported.into());
        }Ok(object)
    })();result.unwrap_or_else(|error|failure(&api,env,"launch-helper",error))
}
fn with_child<A>(api:&Api,env:Env,args:&[Value;4],live:bool,run:impl FnOnce(&mut Command)->io::Result<A>)->io::Result<A>{
    if live{work_bridge::with_factory(env,args[0],args[1],|_|Ok(()))?;}
    let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    let entry=all.get_mut(&(env as usize)).and_then(|state|state.entries.get_mut(&api.pointer(env,args[2]).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
    if entry.capture!=api.pointer(env,args[0])?||entry.factory!=api.pointer(env,args[1])?{return Err(io::ErrorKind::PermissionDenied.into());}
    run(&mut entry.child)
}
unsafe extern "C" fn write(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{
        let args=args(&api,env,info,4)?;let control=api.string(env,args[3])?;
        if control!="continue"&&control!="cancel"{return Err(io::ErrorKind::PermissionDenied.into());}
        with_child(&api,env,&args,control=="continue",|child|child.control(&control))?;undefined(&api,env)
    })();result.unwrap_or_else(|error|failure(&api,env,"control-command",error))
}
unsafe extern "C" fn stop(env:Env,info:*mut c_void)->Value{action(env,info,false,"cancel-command",|child|child.control("cancel"))}
fn action(env:Env,info:*mut c_void,live:bool,stage:&'static str,run:impl FnOnce(&mut Command)->io::Result<()>)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;with_child(&api,env,&args,live,run)?;undefined(&api,env)})();
    result.unwrap_or_else(|error|failure(&api,env,stage,error))
}
unsafe extern "C" fn read(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{
        let args=args(&api,env,info,3)?;let Observation{kind,bytes,exit_code}=with_child(&api,env,&args,false,Command::read)?;
        let text=serde_json::to_string(&serde_json::json!({"version":1,"kind":kind,"exit_code":exit_code,"payload_bytes":bytes.len()}))?;
        let metadata=api.text(env,&text)?;let mut payload=ptr::null_mut();let mut object=ptr::null_mut();
        if unsafe{(api.create_object)(env,&mut object)}!=0||unsafe{(api.buffer_copy)(env,bytes.len(),bytes.as_ptr().cast(),ptr::null_mut(),&mut payload)}!=0||
            unsafe{(api.set_property)(env,object,c"metadata".as_ptr(),metadata)}!=0||unsafe{(api.set_property)(env,object,c"bytes".as_ptr(),payload)}!=0{
            return Err(io::ErrorKind::Unsupported.into());
        }Ok(object)
    })();result.unwrap_or_else(|error|failure(&api,env,"read-child",error))
}
unsafe extern "C" fn describe(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;let value=with_child(&api,env,&args,false,|child|Ok(child.description()))?;api.text(env,&serde_json::to_string(&value)?)})();
    result.unwrap_or_else(|error|failure(&api,env,"describe-command",error))
}
unsafe extern "C" fn close(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};
    let result=(||->io::Result<Value>{
        let args=args(&api,env,info,3)?;let closed=with_child(&api,env,&args,false,Command::close)?;
        if closed{
            let removed=states().lock().map_err(|_|io::ErrorKind::Other)?.get_mut(&(env as usize)).and_then(|state|state.entries.remove(&api.pointer(env,args[2]).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
            unsafe{(api.delete_reference)(env,removed.factory_reference as *mut c_void);(api.delete_reference)(env,removed.workspace_reference as *mut c_void);}
        }
        let mut value=ptr::null_mut();if unsafe{(api.create_boolean)(env,closed,&mut value)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok(value)
    })();result.unwrap_or_else(|error|failure(&api,env,"close-child",error))
}
pub(super) fn factory_can_close(env:Env,factory:usize)->io::Result<bool>{
    let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    let Some(state)=all.get_mut(&(env as usize))else{return Ok(true);};
    if state.blocked.contains(&factory){return Ok(false);}
    for entry in state.entries.values_mut().filter(|entry|entry.factory==factory){if entry.child.control("cancel").is_err(){return Ok(false);}if !entry.child.close()?{return Ok(false);}}
    Ok(true)
}
pub(super) fn workspace_can_close(env:Env,workspace:usize)->io::Result<bool>{
    let all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    Ok(all.get(&(env as usize)).is_none_or(|state|state.pending==0&&!state.entries.values().any(|entry|entry.workspace==workspace)))
}
fn undefined(api:&Api,env:Env)->io::Result<Value>{let mut value=ptr::null_mut();if unsafe{(api.undefined)(env,&mut value)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok(value)}
fn failure(api:&Api,env:Env,stage:&'static str,error:io::Error)->Value{
    eprintln!("WINDOWS_WORK_COMMAND_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));
    api.error(env,c"WINDOWS_WORK_COMMAND_UNAVAILABLE")
}
fn retain(child:Command){if let Err(child)=child.retire(){std::mem::forget(child);}}
unsafe extern "C" fn finalize(env:Env,token:*mut c_void,_:*mut c_void){
    if token.is_null(){return;}
    let removed=states().lock().ok().and_then(|mut all|all.get_mut(&(env as usize)).and_then(|state|state.entries.remove(&(token as usize))));
    if let Some(entry)=removed{match entry.child.retire(){
        Ok(())=>{if let Ok(api)=Api::load(){unsafe{(api.delete_reference)(env,entry.factory_reference as *mut c_void);(api.delete_reference)(env,entry.workspace_reference as *mut c_void);}}},
        Err(child)=>{let _=states().lock().map(|mut all|{if let Some(state)=all.get_mut(&(env as usize)){state.blocked.insert(entry.factory);state.entries.insert(token as usize,Entry{child,..entry});}});return;}
    }}
    unsafe{drop(Box::from_raw(token.cast::<usize>()));}
}
unsafe extern "C" fn cleanup(env:*mut c_void){
    let Ok(mut all)=states().lock()else{return;};
    let Some(state)=all.get_mut(&(env as usize))else{return;};
    for entry in state.entries.values_mut(){let _=entry.child.control("cancel");}
    let start=std::time::Instant::now();
    while start.elapsed()<std::time::Duration::from_secs(5){
        state.entries.retain(|_,entry|entry.child.close().ok()!=Some(true));
        if state.entries.is_empty(){break;}
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Leave unknown original custody visible to the factory cleanup hook. It
    // retains the image lease and cannot interpret environment teardown as Stop.
    if state.entries.is_empty()&&state.blocked.is_empty(){all.remove(&(env as usize));}
}
