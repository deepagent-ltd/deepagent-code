//! Offline issuer-only fixed runtime RX preparation and Native file observations. No callback produces a
//! Registered/Installed/preloaded/Work capability or launches a process.
use super::{napi, publisher::Publisher};
use serde::Deserialize;
use std::{collections::HashMap, ffi::{c_char, c_void}, io, path::Path, ptr, sync::{Mutex, OnceLock}};
type Env = *mut c_void;
type Value = *mut c_void;
type Callback = unsafe extern "C" fn(Env, *mut c_void) -> Value;
type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);
const MAX_BODY: usize = 8192;
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}
#[derive(Clone, Copy)]
struct Api {
    create_external: unsafe extern "C" fn(Env, *mut c_void, Option<Finalizer>, *mut c_void, *mut Value) -> i32,
    get_external: unsafe extern "C" fn(Env, Value, *mut *mut c_void) -> i32,
    create_reference: unsafe extern "C" fn(Env, Value, u32, *mut *mut c_void) -> i32,
    delete_reference: unsafe extern "C" fn(Env, *mut c_void) -> i32,
    create_function: unsafe extern "C" fn(Env, *const c_char, usize, Callback, *mut c_void, *mut Value) -> i32,
    set_property: unsafe extern "C" fn(Env, Value, *const c_char, Value) -> i32,
    get_cb_info: unsafe extern "C" fn(Env, *mut c_void, *mut usize, *mut Value, *mut Value, *mut *mut c_void) -> i32,
    get_string: unsafe extern "C" fn(Env, Value, *mut c_char, usize, *mut usize) -> i32,
    create_string: unsafe extern "C" fn(Env, *const c_char, usize, *mut Value) -> i32,
    undefined: unsafe extern "C" fn(Env, *mut Value) -> i32,
    throw_error: unsafe extern "C" fn(Env, *const c_char, *const c_char) -> i32,
    cleanup: unsafe extern "C" fn(Env, unsafe extern "C" fn(*mut c_void), *mut c_void) -> i32,
}
impl Api {
    fn load() -> io::Result<Self> {
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
            cleanup: symbol!("napi_add_env_cleanup_hook", unsafe extern "C" fn(Env,unsafe extern "C" fn(*mut c_void),*mut c_void)->i32),
        })
    }
    fn error(&self, env: Env, code: &std::ffi::CStr) -> Value {
        unsafe { (self.throw_error)(env, code.as_ptr(), c"Windows offline publisher observation is unavailable".as_ptr()); }
        ptr::null_mut()
    }
    fn string(&self, env: Env, value: Value) -> io::Result<String> {
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
    fn text(&self, env: Env, text: &str) -> io::Result<Value> {
        if text.len() > MAX_BODY { return Err(io::ErrorKind::InvalidData.into()); }
        let mut result = ptr::null_mut();
        if unsafe { (self.create_string)(env,text.as_ptr().cast(),text.len(),&mut result) } != 0 {
            return Err(io::ErrorKind::Unsupported.into());
        } Ok(result)
    }
    fn pointer(&self, env: Env, value: Value) -> io::Result<usize> {
        let mut pointer = ptr::null_mut();
        if unsafe { (self.get_external)(env,value,&mut pointer) } != 0 || pointer.is_null() {
            return Err(io::ErrorKind::PermissionDenied.into());
        } Ok(pointer as usize)
    }
}

struct Entry { capture: usize, capture_reference: usize, lease: Publisher }
struct State { api: Api, entries: HashMap<usize, Entry> }
static STATES: OnceLock<Mutex<HashMap<usize, State>>> = OnceLock::new();
fn states() -> &'static Mutex<HashMap<usize, State>> { STATES.get_or_init(|| Mutex::new(HashMap::new())) }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { version: u8, purpose: String, module: String, runtime: String }
pub fn register(env: Env, exports: Value) -> io::Result<()> {
    let api = Api::load()?;
    let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)) { return Err(io::ErrorKind::PermissionDenied.into()); }
    all.insert(env as usize, State { api, entries: HashMap::new() }); drop(all);
    if unsafe { (api.cleanup)(env, cleanup, env) } != 0 { cleanup_state(env); return Err(io::ErrorKind::Unsupported.into()); }
    for (name, callback) in [(c"prepareWorkRuntime", prepare_runtime as Callback), (c"prepareCliWorkRuntime", prepare_cli_runtime as Callback), (c"openPublisher", open as Callback),
        (c"readPublisher", read as Callback), (c"closePublisher", close as Callback)] {
        let mut value = ptr::null_mut();
        if unsafe { (api.create_function)(env,name.as_ptr(),name.to_bytes().len(),callback,ptr::null_mut(),&mut value) } != 0 ||
            unsafe { (api.set_property)(env,exports,name.as_ptr(),value) } != 0 { cleanup_state(env); return Err(io::ErrorKind::Unsupported.into()); }
    } Ok(())
}
unsafe extern "C" fn prepare_runtime(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api, env, info, 1)?;
        let all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let state = all.get(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if !state.entries.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let text = napi::with_current_image(env, args[0], Publisher::prepare_work_runtime)?;
        api.text(env, &text)
    })();
    result.unwrap_or_else(|error| { diagnostic("work-runtime", error); api.error(env, c"WINDOWS_PUBLISHER_UNAVAILABLE") })
}
unsafe extern "C" fn prepare_cli_runtime(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api, env, info, 1)?;
        let all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let state = all.get(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if !state.entries.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let text = napi::with_current_image(env, args[0], Publisher::prepare_cli_work_runtime)?;
        api.text(env, &text)
    })();
    result.unwrap_or_else(|error| { diagnostic("cli-work-runtime", error); api.error(env, c"WINDOWS_PUBLISHER_UNAVAILABLE") })
}
fn arguments(api: &Api, env: Env, info: *mut c_void, expected: usize) -> io::Result<[Value; 3]> {
    let mut count = 3; let mut args = [ptr::null_mut(); 3];
    if unsafe { (api.get_cb_info)(env,info,&mut count,args.as_mut_ptr(),ptr::null_mut(),ptr::null_mut()) } != 0 || count != expected ||
        !napi::same_capture(env,args[0]) { return Err(io::ErrorKind::PermissionDenied.into()); } Ok(args)
}
unsafe extern "C" fn open(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        let request: Request = serde_json::from_str(&api.string(env,args[1])?)?;
        if request.version != 1 || !matches!(request.purpose.as_str(), "offline-node-publisher" | "offline-cli-publisher") { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let state = all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        if !state.entries.is_empty() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let lease = napi::with_current_image(env,args[0],|image| {
            if request.purpose == "offline-cli-publisher" {
                return Publisher::open_cli(image,Path::new(&request.module),Path::new(&request.runtime));
            }
            Publisher::open(image,Path::new(&request.module),Path::new(&request.runtime))
        })?;
        let mut reference = ptr::null_mut();
        if unsafe { (api.create_reference)(env,args[0],1,&mut reference) } != 0 || reference.is_null() { return Err(io::ErrorKind::Unsupported.into()); }
        let token = Box::into_raw(Box::new(env as usize)); let mut value = ptr::null_mut();
        if unsafe { (api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut value) } != 0 {
            unsafe { drop(Box::from_raw(token)); (api.delete_reference)(env,reference); } return Err(io::ErrorKind::Unsupported.into());
        }
        state.entries.insert(token as usize, Entry { capture: api.pointer(env,args[0])?, capture_reference: reference as usize, lease });
        Ok(value)
    })(); result.unwrap_or_else(|error| { diagnostic("open",error); api.error(env,c"WINDOWS_PUBLISHER_UNAVAILABLE") })
}
unsafe extern "C" fn read(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        let all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let entry = all.get(&(env as usize)).and_then(|state| state.entries.get(&api.pointer(env,args[1]).ok()?)).ok_or(io::ErrorKind::PermissionDenied)?;
        if entry.capture != api.pointer(env,args[0])? { return Err(io::ErrorKind::PermissionDenied.into()); }
        let text = napi::with_current_image(env,args[0],|image| entry.lease.describe(image).map(str::to_owned))?;
        api.text(env,&text)
    })(); result.unwrap_or_else(|error| { diagnostic("read",error); api.error(env,c"WINDOWS_PUBLISHER_UNAVAILABLE") })
}
unsafe extern "C" fn close(env: Env, info: *mut c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        let state = all.get_mut(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
        let token = api.pointer(env,args[1])?;
        if state.entries.get(&token).is_none_or(|entry| entry.capture != api.pointer(env,args[0]).unwrap_or(0)) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let entry = state.entries.remove(&token).ok_or(io::ErrorKind::PermissionDenied)?; drop(all);
        drop(entry.lease); unsafe { (api.delete_reference)(env,entry.capture_reference as *mut c_void); }
        let mut value = ptr::null_mut();
        if unsafe { (api.undefined)(env,&mut value) } != 0 { return Err(io::ErrorKind::Unsupported.into()); } Ok(value)
    })(); result.unwrap_or_else(|_| api.error(env,c"WINDOWS_PUBLISHER_UNAVAILABLE"))
}
fn diagnostic(stage: &'static str, error: io::Error) {
    eprintln!("WINDOWS_PUBLISHER_FAILURE stage={stage} kind={:?} os={}", error.kind(),error.raw_os_error().unwrap_or(0));
}
fn cleanup_state(env: Env) {
    let removed = states().lock().ok().and_then(|mut all| all.remove(&(env as usize)));
    if let Some(state) = removed { for entry in state.entries.into_values() { drop(entry.lease); unsafe { (state.api.delete_reference)(env,entry.capture_reference as *mut c_void); } } }
}
unsafe extern "C" fn cleanup(env: *mut c_void) { cleanup_state(env); }
unsafe extern "C" fn finalize(env: Env, token: *mut c_void, _: *mut c_void) {
    if token.is_null() { return; }
    let removed = states().lock().ok().and_then(|mut all| all.get_mut(&(env as usize)).and_then(|state| state.entries.remove(&(token as usize))));
    if let Some(entry) = removed { drop(entry.lease); if let Ok(api) = Api::load() { unsafe { (api.delete_reference)(env,entry.capture_reference as *mut c_void); } } }
    unsafe { drop(Box::from_raw(token.cast::<usize>())); }
}
