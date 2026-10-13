//! An original preloaded token is the only constructor for fixed Work images.
use super::{napi, work_factory::WorkFactory};
use std::{collections::HashMap, ffi::{c_char, c_void}, io, ptr, sync::{Mutex, OnceLock}};
type Env = *mut c_void;
type Value = *mut c_void;
type Callback = unsafe extern "C" fn(Env, *mut c_void) -> Value;
type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);
const MAX_BODY: usize = 1_048_576;
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}
#[derive(Clone, Copy)]
pub(super) struct Api {
    pub(super) create_external: unsafe extern "C" fn(Env, *mut c_void, Option<Finalizer>, *mut c_void, *mut Value) -> i32,
    pub(super) get_external: unsafe extern "C" fn(Env, Value, *mut *mut c_void) -> i32,
    pub(super) create_reference: unsafe extern "C" fn(Env, Value, u32, *mut *mut c_void) -> i32,
    pub(super) delete_reference: unsafe extern "C" fn(Env, *mut c_void) -> i32,
    pub(super) create_function: unsafe extern "C" fn(Env, *const c_char, usize, Callback, *mut c_void, *mut Value) -> i32,
    pub(super) set_property: unsafe extern "C" fn(Env, Value, *const c_char, Value) -> i32,
    pub(super) get_cb_info: unsafe extern "C" fn(Env, *mut c_void, *mut usize, *mut Value, *mut Value, *mut *mut c_void) -> i32,
    get_string: unsafe extern "C" fn(Env, Value, *mut c_char, usize, *mut usize) -> i32,
    pub(super) create_string: unsafe extern "C" fn(Env, *const c_char, usize, *mut Value) -> i32,
    pub(super) undefined: unsafe extern "C" fn(Env, *mut Value) -> i32,
    throw_error: unsafe extern "C" fn(Env, *const c_char, *const c_char) -> i32,
    pub(super) create_object: unsafe extern "C" fn(Env,*mut Value)->i32,
    pub(super) create_uint: unsafe extern "C" fn(Env,u32,*mut Value)->i32,
    pub(super) create_boolean: unsafe extern "C" fn(Env,bool,*mut Value)->i32,
    pub(super) buffer_info: unsafe extern "C" fn(Env,Value,*mut *mut c_void,*mut usize)->i32,
    pub(super) buffer_copy: unsafe extern "C" fn(Env,usize,*const c_void,*mut *mut c_void,*mut Value)->i32,
    pub(super) cleanup: unsafe extern "C" fn(Env, unsafe extern "C" fn(*mut c_void), *mut c_void) -> i32,
}
impl Api {
    pub(super) fn load() -> io::Result<Self> {
        let module = unsafe { GetModuleHandleW(ptr::null()) };
        if module == 0 { return Err(io::ErrorKind::Unsupported.into()); }
        macro_rules! symbol { ($name:literal, $kind:ty) => {{
            let value = unsafe { GetProcAddress(module, concat!($name, "\0").as_ptr()) };
            if value.is_null() { return Err(io::ErrorKind::Unsupported.into()); }
            unsafe { std::mem::transmute::<*const c_void, $kind>(value) }
        }} }
        Ok(Self {
            create_external: symbol!("napi_create_external", unsafe extern "C" fn(Env,*mut c_void,Option<Finalizer>,*mut c_void,*mut Value)->i32),
            get_external: symbol!("napi_get_value_external", unsafe extern "C" fn(Env,Value,*mut *mut c_void)->i32),
            create_reference: symbol!("napi_create_reference", unsafe extern "C" fn(Env,Value,u32,*mut *mut c_void)->i32),
            delete_reference: symbol!("napi_delete_reference", unsafe extern "C" fn(Env,*mut c_void)->i32),
            create_function: symbol!("napi_create_function", unsafe extern "C" fn(Env,*const c_char,usize,Callback,*mut c_void,*mut Value)->i32),
            set_property: symbol!("napi_set_named_property", unsafe extern "C" fn(Env,Value,*const c_char,Value)->i32),
            get_cb_info: symbol!("napi_get_cb_info", unsafe extern "C" fn(Env,*mut c_void,*mut usize,*mut Value,*mut Value,*mut *mut c_void)->i32),
            get_string: symbol!("napi_get_value_string_utf8", unsafe extern "C" fn(Env,Value,*mut c_char,usize,*mut usize)->i32),
            create_string: symbol!("napi_create_string_utf8", unsafe extern "C" fn(Env,*const c_char,usize,*mut Value)->i32),
            undefined: symbol!("napi_get_undefined", unsafe extern "C" fn(Env,*mut Value)->i32),
            throw_error: symbol!("napi_throw_error", unsafe extern "C" fn(Env,*const c_char,*const c_char)->i32),
            create_object: symbol!("napi_create_object",unsafe extern "C" fn(Env,*mut Value)->i32),
            create_uint: symbol!("napi_create_uint32",unsafe extern "C" fn(Env,u32,*mut Value)->i32),
            create_boolean: symbol!("napi_get_boolean",unsafe extern "C" fn(Env,bool,*mut Value)->i32),
            buffer_info: symbol!("napi_get_buffer_info",unsafe extern "C" fn(Env,Value,*mut *mut c_void,*mut usize)->i32),
            buffer_copy: symbol!("napi_create_buffer_copy",unsafe extern "C" fn(Env,usize,*const c_void,*mut *mut c_void,*mut Value)->i32),
            cleanup: symbol!("napi_add_env_cleanup_hook", unsafe extern "C" fn(Env,unsafe extern "C" fn(*mut c_void),*mut c_void)->i32),
        })
    }
    pub(super) fn error(&self, env: Env, code: &std::ffi::CStr) -> Value {
        unsafe { (self.throw_error)(env, code.as_ptr(), c"Windows original Work factory is unavailable".as_ptr()); }
        ptr::null_mut()
    }
    pub(super) fn string(&self, env: Env, value: Value) -> io::Result<String> {
        let mut length = 0;
        if unsafe { (self.get_string)(env,value,ptr::null_mut(),0,&mut length) } != 0 || length > MAX_BODY {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut bytes = vec![0u8; length + 1]; let mut observed = 0;
        if unsafe { (self.get_string)(env,value,bytes.as_mut_ptr().cast(),bytes.len(),&mut observed) } != 0 || observed != length {
            return Err(io::ErrorKind::InvalidData.into());
        }
        bytes.truncate(length); String::from_utf8(bytes).map_err(|_| io::ErrorKind::InvalidData.into())
    }
    pub(super) fn text(&self, env: Env, text: &str) -> io::Result<Value> {
        if text.len() > MAX_BODY { return Err(io::ErrorKind::InvalidData.into()); }
        let mut result = ptr::null_mut();
        if unsafe { (self.create_string)(env,text.as_ptr().cast(),text.len(),&mut result) } != 0 {
            return Err(io::ErrorKind::Unsupported.into());
        } Ok(result)
    }
    pub(super) fn pointer(&self, env: Env, value: Value) -> io::Result<usize> {
        let mut pointer = ptr::null_mut();
        if unsafe { (self.get_external)(env,value,&mut pointer) } != 0 || pointer.is_null() {
            return Err(io::ErrorKind::PermissionDenied.into());
        } Ok(pointer as usize)
    }
}

struct Entry { capture: usize, capture_reference: usize, lease: WorkFactory }
struct State { api: Api, entries: HashMap<usize, Entry> }
static STATES: OnceLock<Mutex<HashMap<usize, State>>> = OnceLock::new();
fn states() -> &'static Mutex<HashMap<usize, State>> { STATES.get_or_init(|| Mutex::new(HashMap::new())) }
pub fn register(env: Env, exports: Value) -> io::Result<()> {
    let api = Api::load()?;
    let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)) { return Err(io::ErrorKind::PermissionDenied.into()); }
    all.insert(env as usize, State { api, entries: HashMap::new() }); drop(all);
    if unsafe { (api.cleanup)(env, cleanup, env) } != 0 { cleanup_state(env); return Err(io::ErrorKind::Unsupported.into()); }
    for (name, callback) in [(c"openWorkFactory", open as Callback), (c"readWorkFactory", read as Callback), (c"closeWorkFactory", close as Callback)] {
        let mut value = ptr::null_mut();
        if unsafe { (api.create_function)(env,name.as_ptr(),name.to_bytes().len(),callback,ptr::null_mut(),&mut value) } != 0 ||
            unsafe { (api.set_property)(env,exports,name.as_ptr(),value) } != 0 { cleanup_state(env); return Err(io::ErrorKind::Unsupported.into()); }
    } Ok(())
}
fn arguments(api: &Api, env: Env, info: *mut c_void, expected: usize) -> io::Result<[Value; 3]> {
    let mut count = 3; let mut args = [ptr::null_mut(); 3];
    if unsafe { (api.get_cb_info)(env,info,&mut count,args.as_mut_ptr(),ptr::null_mut(),ptr::null_mut()) } != 0 || count != expected ||
        !napi::same_capture(env,args[0]) { return Err(io::ErrorKind::PermissionDenied.into()); } Ok(args)
}
unsafe extern "C" fn open(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,1)?;
        let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let state = all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if state.entries.len() >= 8 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let lease = napi::with_preloaded_image(env,args[0],WorkFactory::open)?;
        let mut reference = ptr::null_mut();
        if unsafe { (api.create_reference)(env,args[0],1,&mut reference) } != 0 || reference.is_null() { return Err(io::ErrorKind::Unsupported.into()); }
        let token = Box::into_raw(Box::new(env as usize)); let mut value = ptr::null_mut();
        if unsafe { (api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut value) } != 0 {
            unsafe { drop(Box::from_raw(token)); (api.delete_reference)(env,reference); } return Err(io::ErrorKind::Unsupported.into());
        }
        state.entries.insert(token as usize, Entry { capture: api.pointer(env,args[0])?, capture_reference: reference as usize, lease });
        Ok(value)
    })(); result.unwrap_or_else(|error| { diagnostic("open",error); api.error(env,c"WINDOWS_WORK_FACTORY_UNAVAILABLE") })
}
unsafe extern "C" fn read(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        let all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let entry = all.get(&(env as usize)).and_then(|state| state.entries.get(&api.pointer(env,args[1]).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
        if entry.capture != api.pointer(env,args[0])? { return Err(io::ErrorKind::PermissionDenied.into()); }
        let text = napi::with_preloaded_image(env,args[0],|image,proof| entry.lease.describe(image,proof).map(str::to_owned))?;
        api.text(env,&text)
    })(); result.unwrap_or_else(|error| { diagnostic("read",error); api.error(env,c"WINDOWS_WORK_FACTORY_UNAVAILABLE") })
}
unsafe extern "C" fn close(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let state = all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        let token = api.pointer(env,args[1])?;
        if state.entries.get(&token).is_none_or(|entry| entry.capture != api.pointer(env,args[0]).unwrap_or(0)) { return Err(io::ErrorKind::PermissionDenied.into()); }
        if !can_close(env,token)? { return Err(io::ErrorKind::WouldBlock.into()); }
        let entry = state.entries.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?; drop(all);
        drop(entry.lease); unsafe { (api.delete_reference)(env,entry.capture_reference as *mut c_void); }
        let mut value = ptr::null_mut();
        if unsafe { (api.undefined)(env,&mut value) } != 0 { return Err(io::ErrorKind::Unsupported.into()); } Ok(value)
    })(); result.unwrap_or_else(|_| api.error(env,c"WINDOWS_WORK_FACTORY_UNAVAILABLE"))
}
pub(super) fn with_factory<A>(env:Env,capture:Value,lease:Value,run:impl FnOnce(&WorkFactory)->io::Result<A>)->io::Result<A>{
    with_original_factory(env,capture,lease,|_,_,factory|run(factory))
}
pub(super) fn with_original_factory<A>(env:Env,capture:Value,lease:Value,
    run:impl FnOnce(&super::loader::FirstLoad,&super::preload::Evidence,&WorkFactory)->io::Result<A>)->io::Result<A>{
    let api=Api::load()?;
    if !napi::same_capture(env,capture){return Err(io::ErrorKind::PermissionDenied.into());}
    let all=states().lock().map_err(|_|io::ErrorKind::Other)?;
    let entry=all.get(&(env as usize)).and_then(|state|state.entries.get(&api.pointer(env,lease).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
    if entry.capture!=api.pointer(env,capture)?{return Err(io::ErrorKind::PermissionDenied.into());}
    napi::with_preloaded_image(env,capture,|image,proof|{entry.lease.current(image,proof)?;run(image,proof,&entry.lease)})
}

fn diagnostic(stage: &'static str, error: io::Error) {
    eprintln!("WINDOWS_WORK_FACTORY_FAILURE stage={stage} kind={:?} os={}", error.kind(),error.raw_os_error().unwrap_or(0));
}
fn can_close(env: Env, token: usize) -> io::Result<bool> {
    Ok(super::work_child_bridge::factory_can_close(env,token)? &&
        super::work_command_bridge::factory_can_close(env,token)? &&
        super::work_workspace_bridge::factory_can_close(env,token)? &&
        super::work_command_cleanup_bridge::factory_can_close(env,token)? && super::event_git_bridge::factory_can_close(env,token)?)
}
fn cleanup_state(env: Env) {
    let removed = states().lock().ok().and_then(|mut all| all.remove(&(env as usize)));
    if let Some(state) = removed { for (token,entry) in state.entries { if can_close(env,token).ok()!=Some(true){std::mem::forget(entry);continue;} drop(entry.lease); unsafe { (state.api.delete_reference)(env,entry.capture_reference as *mut c_void); } } }
}
unsafe extern "C" fn cleanup(env: *mut c_void) { cleanup_state(env); }
unsafe extern "C" fn finalize(env: Env, token: *mut c_void, _: *mut c_void) {
    if token.is_null() { return; }
    let removed = states().lock().ok().and_then(|mut all| all.get_mut(&(env as usize)).and_then(|state| state.entries.remove(&(token as usize))));
    if let Some(entry) = removed { if can_close(env,token as usize).ok()!=Some(true){std::mem::forget(entry);return;} drop(entry.lease); if let Ok(api) = Api::load() { unsafe { (api.delete_reference)(env,entry.capture_reference as *mut c_void); } } }
    unsafe { drop(Box::from_raw(token.cast::<usize>())); }
}
