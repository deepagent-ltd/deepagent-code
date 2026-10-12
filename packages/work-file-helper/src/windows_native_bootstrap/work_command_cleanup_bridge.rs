//! Known-only cleanup Externals remain tied to the original capture and fixed Work factory.
//! JSON describes bounded inventory; neither paths nor stored metadata mint a lease.
use super::{napi,work_bridge::{self,Api},work_command_cleanup::{Collector,Request}};
use std::{collections::HashMap,ffi::c_void,io,ptr,sync::{Mutex,OnceLock}};
type Env=*mut c_void;type Value=*mut c_void;type Callback=unsafe extern "C" fn(Env,*mut c_void)->Value;
struct Entry{capture:usize,factory:usize,reference:usize,collector:Collector}
struct State{entries:HashMap<usize,Entry>,pending:usize}
static STATES:OnceLock<Mutex<HashMap<usize,State>>>=OnceLock::new();
fn states()->&'static Mutex<HashMap<usize,State>>{STATES.get_or_init(||Mutex::new(HashMap::new()))}
pub(super) fn register(env:Env,exports:Value)->io::Result<()>{
    let api=Api::load()?;let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)){return Err(io::ErrorKind::PermissionDenied.into());}
    all.insert(env as usize,State{entries:HashMap::new(),pending:0});drop(all);
    if unsafe{(api.cleanup)(env,cleanup,env)}!=0{return Err(io::ErrorKind::Unsupported.into());}
    for(name,callback)in[(c"openKnownCommandCleanup",open as Callback),(c"currentKnownCommandCleanup",current as Callback),
        (c"collectKnownCommandCleanup",collect as Callback),(c"closeKnownCommandCleanup",close as Callback)]{
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
        let request:Request=serde_json::from_str(&api.string(env,args[2])?).map_err(io::Error::other)?;
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if state.entries.len()+state.pending>=8{return Err(io::ErrorKind::WouldBlock.into());}state.pending+=1;drop(all);
        let collector=work_bridge::with_factory(env,args[0],args[1],|_|Collector::open(request));
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;state.pending-=1;
        let collector=collector?;let metadata=api.text(env,&collector.current()?)?;let mut reference=ptr::null_mut();
        if unsafe{(api.create_reference)(env,args[1],1,&mut reference)}!=0||reference.is_null(){return Err(io::ErrorKind::Unsupported.into());}
        let token=Box::into_raw(Box::new(env as usize));let mut external=ptr::null_mut();
        if unsafe{(api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut external)}!=0{
            unsafe{drop(Box::from_raw(token));(api.delete_reference)(env,reference);}return Err(io::ErrorKind::Unsupported.into());}
        state.entries.insert(token as usize,Entry{capture,factory,reference:reference as usize,collector});
        let mut object=ptr::null_mut();if unsafe{(api.create_object)(env,&mut object)}!=0||
            unsafe{(api.set_property)(env,object,c"lease".as_ptr(),external)}!=0||unsafe{(api.set_property)(env,object,c"metadata".as_ptr(),metadata)}!=0{
            return Err(io::ErrorKind::Unsupported.into());}Ok(object)
    })();result.unwrap_or_else(|error|failure(&api,env,"open",error))
}
fn with_collector<A>(api:&Api,env:Env,args:&[Value;4],run:impl FnOnce(&mut Collector)->io::Result<A>)->io::Result<A>{
    work_bridge::with_factory(env,args[0],args[1],|_|Ok(()))?;
    let token=api.pointer(env,args[2])?;let capture=api.pointer(env,args[0])?;let factory=api.pointer(env,args[1])?;
    // Lookup the original registry before any External pointer dereference. Tokens never carry authority.
    let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let entry=all.get_mut(&(env as usize)).and_then(|state|state.entries.get_mut(&token)).ok_or(io::ErrorKind::PermissionDenied)?;
    if entry.capture!=capture||entry.factory!=factory{return Err(io::ErrorKind::PermissionDenied.into());}run(&mut entry.collector)
}
unsafe extern "C" fn current(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
        let metadata=with_collector(&api,env,&args,|collector|collector.current())?;api.text(env,&metadata)})();
    result.unwrap_or_else(|error|failure(&api,env,"current",error))
}
unsafe extern "C" fn collect(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
        let metadata=with_collector(&api,env,&args,|collector|collector.collect())?;api.text(env,&metadata)})();
    result.unwrap_or_else(|error|failure(&api,env,"cleanup",error))
}
unsafe extern "C" fn close(env:Env,info:*mut c_void)->Value{
    let Ok(api)=Api::load()else{return ptr::null_mut();};let result=(||->io::Result<Value>{let args=args(&api,env,info,3)?;
        let capture=api.pointer(env,args[0])?;let factory=api.pointer(env,args[1])?;let token=api.pointer(env,args[2])?;
        let mut all=states().lock().map_err(|_|io::ErrorKind::Other)?;let state=all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        let entry=state.entries.get(&token).ok_or(io::ErrorKind::PermissionDenied)?;
        if entry.capture!=capture||entry.factory!=factory{return Err(io::ErrorKind::PermissionDenied.into());}
        if entry.collector.is_unknown(){return Err(io::ErrorKind::WouldBlock.into());}
        let entry=state.entries.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?;drop(entry.collector);drop(all);
        unsafe{(api.delete_reference)(env,entry.reference as *mut c_void);}undefined(&api,env)})();
    result.unwrap_or_else(|error|failure(&api,env,"close",error))
}
pub(super) fn factory_can_close(env:Env,factory:usize)->io::Result<bool>{
    let all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    Ok(all.get(&(env as usize)).is_none_or(|state|state.pending==0&&!state.entries.values().any(|entry|entry.factory==factory)))
}
fn undefined(api:&Api,env:Env)->io::Result<Value>{let mut value=ptr::null_mut();if unsafe{(api.undefined)(env,&mut value)}!=0{return Err(io::ErrorKind::Unsupported.into());}Ok(value)}
fn failure(api:&Api,env:Env,stage:&'static str,error:io::Error)->Value{eprintln!("WINDOWS_KNOWN_COMMAND_CLEANUP_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0));api.error(env,c"WINDOWS_KNOWN_COMMAND_CLEANUP_UNAVAILABLE")}
unsafe extern "C" fn finalize(env:Env,token:*mut c_void,_:*mut c_void){
    if token.is_null(){return;}
    let Ok(mut all)=states().lock()else{return;};let Some(state)=all.get_mut(&(env as usize))else{return;};
    if state.entries.get(&(token as usize)).is_some_and(|entry|entry.collector.is_unknown()){
        // Unknown physical deletion retains the original collector/factory custody;
        // JavaScript GC is not a known retirement or a release permit.
        return;
    }
    let removed=state.entries.remove(&(token as usize));drop(all);
    if let Some(entry)=removed{drop(entry.collector);if let Ok(api)=Api::load(){unsafe{(api.delete_reference)(env,entry.reference as *mut c_void);}}}
    unsafe{drop(Box::from_raw(token.cast::<usize>()));}
}
unsafe extern "C" fn cleanup(env:*mut c_void){let Ok(mut all)=states().lock()else{return;};let Some(state)=all.remove(&(env as usize))else{return;};drop(state);}
