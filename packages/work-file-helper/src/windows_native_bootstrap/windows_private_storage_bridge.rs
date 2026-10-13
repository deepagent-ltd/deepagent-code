//! Fixed-purpose private storage attached to the original native External. The
//! JavaScript description is data; only native table membership grants a lease.
use super::napi;
#[path = "../private_storage/protocol.rs"]
mod private_protocol;
use private_protocol::{Observation, Purpose};
#[path = "../private_storage/windows.rs"]
mod storage;
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, ffi::{c_char, c_void}, io, ptr, sync::{Mutex, OnceLock}};
type Env = *mut c_void;
type Value = *mut c_void;
type Callback = unsafe extern "C" fn(Env, *mut c_void) -> Value;
type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);
const MAX_BODY: usize = 65_536;
const MAX_BYTES: usize = 1_048_576;
const MAX_LEASES: usize = 8;
const MAX_OPERATIONS: usize = 32;

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
    create_object: unsafe extern "C" fn(Env, *mut Value) -> i32,
    get_buffer: unsafe extern "C" fn(Env, Value, *mut *mut c_void, *mut usize) -> i32,
    copy_buffer: unsafe extern "C" fn(Env, usize, *const c_void, *mut *mut c_void, *mut Value) -> i32,
    is_buffer: unsafe extern "C" fn(Env, Value, *mut bool) -> i32,
    boolean: unsafe extern "C" fn(Env, bool, *mut Value) -> i32,
    undefined: unsafe extern "C" fn(Env, *mut Value) -> i32,
    throw_error: unsafe extern "C" fn(Env, *const c_char, *const c_char) -> i32,
    freeze: unsafe extern "C" fn(Env, Value) -> i32,
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
            create_object: symbol!("napi_create_object", unsafe extern "C" fn(Env,*mut Value)->i32),
            get_buffer: symbol!("napi_get_buffer_info", unsafe extern "C" fn(Env,Value,*mut *mut c_void,*mut usize)->i32),
            copy_buffer: symbol!("napi_create_buffer_copy", unsafe extern "C" fn(Env,usize,*const c_void,*mut *mut c_void,*mut Value)->i32),
            is_buffer: symbol!("napi_is_buffer", unsafe extern "C" fn(Env,Value,*mut bool)->i32),
            boolean: symbol!("napi_get_boolean", unsafe extern "C" fn(Env,bool,*mut Value)->i32),
            undefined: symbol!("napi_get_undefined", unsafe extern "C" fn(Env,*mut Value)->i32),
            throw_error: symbol!("napi_throw_error", unsafe extern "C" fn(Env,*const c_char,*const c_char)->i32),
            freeze: symbol!("napi_object_freeze", unsafe extern "C" fn(Env,Value)->i32),
            cleanup: symbol!("napi_add_env_cleanup_hook", unsafe extern "C" fn(Env,unsafe extern "C" fn(*mut c_void),*mut c_void)->i32),
        })
    }
    fn error(&self, env: Env, code: &std::ffi::CStr) -> Value {
        unsafe { (self.throw_error)(env, code.as_ptr(), c"Original Windows private storage is unavailable".as_ptr()); }
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

struct Entry { capture: usize, capture_reference: usize, lease: storage::Lease, operations: usize, requests: HashSet<String> }
struct State { api: Api, entries: HashMap<usize, Entry> }
static STATES: OnceLock<Mutex<HashMap<usize, State>>> = OnceLock::new();
fn states() -> &'static Mutex<HashMap<usize, State>> { STATES.get_or_init(|| Mutex::new(HashMap::new())) }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open { version: u8, purpose: Purpose, root: String, prepare: bool, deadline_ms: u64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication { version: u8, id: String, name: String, expected: Option<Observation>, sha256: String, bytes: usize }
#[derive(Serialize)]
struct Metadata<'a> { version: u8, status: &'a str, observation: Option<Observation>, payload_bytes: usize }

pub fn register(env: Env, exports: Value) -> io::Result<()> {
    let api = Api::load()?;
    let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
    if all.contains_key(&(env as usize)) { return Err(io::ErrorKind::PermissionDenied.into()); }
    all.insert(env as usize, State { api, entries: HashMap::new() }); drop(all);
    if unsafe { (api.cleanup)(env, cleanup, env) } != 0 { cleanup_state(env); return Err(io::ErrorKind::Unsupported.into()); }
    for (name, callback) in [(c"openPrivate", open as Callback), (c"currentPrivate", current as Callback),
        (c"readPrivate", read as Callback), (c"pinPrivateInstallation", pin_installation as Callback),
        (c"currentPrivateInstallation", current_installation as Callback),
        (c"publishPrivate", publish as Callback), (c"closePrivate", close as Callback)] {
        let mut value = ptr::null_mut();
        if unsafe { (api.create_function)(env,name.as_ptr(),name.to_bytes().len(),callback,ptr::null_mut(),&mut value) } != 0 ||
            unsafe { (api.set_property)(env,exports,name.as_ptr(),value) } != 0 {
            cleanup_state(env); return Err(io::ErrorKind::Unsupported.into());
        }
    } Ok(())
}
fn arguments(api: &Api, env: Env, info: *mut c_void, expected: usize) -> io::Result<[Value; 5]> {
    let mut count = 5; let mut arguments = [ptr::null_mut(); 5];
    if unsafe { (api.get_cb_info)(env,info,&mut count,arguments.as_mut_ptr(),ptr::null_mut(),ptr::null_mut()) } != 0 || count != expected {
        return Err(io::ErrorKind::InvalidInput.into());
    } Ok(arguments)
}
fn checked<'a>(api: &Api, env: Env, args: &[Value; 5], state: &'a mut State, active: bool) -> io::Result<&'a mut Entry> {
    let capture = api.pointer(env,args[0])?; let token = api.pointer(env,args[1])?;
    let entry = state.entries.get_mut(&token).ok_or(io::ErrorKind::PermissionDenied)?;
    if capture != entry.capture || !napi::same_capture(env,args[0]) || (active && !napi::current_capture(env,args[0])) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    if active {
        if entry.operations >= MAX_OPERATIONS { return Err(io::ErrorKind::OutOfMemory.into()); }
        entry.operations += 1;
        entry.lease.current()?;
    } Ok(entry)
}
unsafe extern "C" fn open(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        if !napi::current_capture(env,args[0]) || state.entries.len() >= MAX_LEASES { return Err(io::ErrorKind::PermissionDenied.into()); }
        let request: Open = serde_json::from_str(&api.string(env,args[1])?).map_err(|_| io::ErrorKind::InvalidData)?;
        if request.version != 1 || request.root.len() > 2048 || request.root.chars().any(char::is_control) ||
            request.deadline_ms == 0 || request.deadline_ms > 30_000 { return Err(io::ErrorKind::InvalidInput.into()); }
        let capture = api.pointer(env,args[0])?;
        let lease = storage::Lease::open(&request.root,request.purpose,request.prepare,request.deadline_ms)?;
        if !napi::current_capture(env,args[0]) { return Err(io::ErrorKind::PermissionDenied.into()); }
        // Hold the original External strongly until this lease retires. Its native
        // address cannot be recycled into a successor capture (the ABA case).
        let mut reference = ptr::null_mut();
        if unsafe { (api.create_reference)(env,args[0],1,&mut reference) } != 0 || reference.is_null() {
            return Err(io::ErrorKind::Unsupported.into());
        }
        let token = Box::into_raw(Box::new(env as usize)); let mut value = ptr::null_mut();
        if unsafe { (api.create_external)(env,token.cast(),Some(finalize),ptr::null_mut(),&mut value) } != 0 {
            unsafe { drop(Box::from_raw(token)); (api.delete_reference)(env,reference); }
            return Err(io::ErrorKind::Unsupported.into());
        }
        state.entries.insert(token as usize,Entry { capture, capture_reference: reference as usize, lease,
            operations: 0, requests: HashSet::new() }); Ok(value)
    })(); result.unwrap_or_else(|_| api.error(env,c"PRIVATE_STORAGE_UNAVAILABLE"))
}
unsafe extern "C" fn current(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let valid = arguments(&api,env,info,2).and_then(|args| checked(&api,env,&args,state,true).map(|_| ())).is_ok();
    let mut result = ptr::null_mut();
    if unsafe { (api.boolean)(env,valid,&mut result) } != 0 { return api.error(env,c"PRIVATE_STORAGE_UNAVAILABLE"); } result
}
unsafe extern "C" fn current_installation(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let valid = arguments(&api,env,info,2).and_then(|args| {
        checked(&api,env,&args,state,true)?.lease.current_pinned_installation()?;
        if !napi::current_capture(env,args[0]) { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(())
    }).is_ok();
    let mut result = ptr::null_mut();
    if unsafe { (api.boolean)(env,valid,&mut result) } != 0 { return api.error(env,c"PRIVATE_STORAGE_UNAVAILABLE"); } result
}
unsafe extern "C" fn pin_installation(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        let entry = checked(&api,env,&args,state,true)?;
        let (observation, mut bytes) = entry.lease.pin_installation()?;
        if !napi::current_capture(env,args[0]) { bytes.fill(0); return Err(io::ErrorKind::PermissionDenied.into()); }
        let copied = (|| -> io::Result<Value> {
            let metadata = api.text(env,&serde_json::to_string(&Metadata {
                version: 1, status: "observed", observation: Some(observation), payload_bytes: bytes.len(),
            })?)?;
            let mut object = ptr::null_mut(); let mut buffer = ptr::null_mut();
            if unsafe { (api.create_object)(env,&mut object) } != 0 ||
                unsafe { (api.copy_buffer)(env,bytes.len(),bytes.as_ptr().cast(),ptr::null_mut(),&mut buffer) } != 0 ||
                unsafe { (api.set_property)(env,object,c"metadata".as_ptr(),metadata) } != 0 ||
                unsafe { (api.set_property)(env,object,c"bytes".as_ptr(),buffer) } != 0 ||
                unsafe { (api.freeze)(env,object) } != 0 { return Err(io::ErrorKind::Unsupported.into()); }
            Ok(object)
        })();
        bytes.fill(0);
        copied
    })(); result.unwrap_or_else(|_| api.error(env,c"PRIVATE_STORAGE_UNAVAILABLE"))
}
unsafe extern "C" fn read(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,3)?; let name = api.string(env,args[2])?;
        let entry = checked(&api,env,&args,state,true).map_err(|error| diagnostic("read-lease", error))?;
        let observed = entry.lease.read(&name).map_err(|error| diagnostic("read-storage", error))?;
        if !napi::current_capture(env,args[0]) { return Err(io::ErrorKind::PermissionDenied.into()); }
        let (metadata, bytes) = match observed {
            Some((observation, bytes)) => (Metadata { version: 1, status: "observed", observation: Some(observation), payload_bytes: bytes.len() }, bytes),
            None => (Metadata { version: 1, status: "missing", observation: None, payload_bytes: 0 }, Vec::new()),
        };
        let metadata = api.text(env,&serde_json::to_string(&metadata)?)?;
        let mut object = ptr::null_mut(); let mut buffer = ptr::null_mut();
        if unsafe { (api.create_object)(env,&mut object) } != 0 ||
            unsafe { (api.copy_buffer)(env,bytes.len(),bytes.as_ptr().cast(),ptr::null_mut(),&mut buffer) } != 0 ||
            unsafe { (api.set_property)(env,object,c"metadata".as_ptr(),metadata) } != 0 ||
            unsafe { (api.set_property)(env,object,c"bytes".as_ptr(),buffer) } != 0 ||
            unsafe { (api.freeze)(env,object) } != 0 { return Err(diagnostic("read-output", io::ErrorKind::Unsupported.into())); }
        Ok(object)
    })(); result.unwrap_or_else(|_| api.error(env,c"PRIVATE_STORAGE_UNAVAILABLE"))
}
unsafe extern "C" fn publish(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let result = (|| -> Result<Value, &'static std::ffi::CStr> {
        let args = arguments(&api,env,info,4).map_err(|_| c"PRIVATE_STORAGE_UNAVAILABLE")?;
        let request: Publication = serde_json::from_str(&api.string(env,args[2]).map_err(|_| c"PRIVATE_STORAGE_UNAVAILABLE")?)
            .map_err(|_| c"PRIVATE_STORAGE_UNAVAILABLE")?;
        let mut is_buffer = false; let mut pointer = ptr::null_mut(); let mut length = 0;
        if request.version != 1 || request.id.len() != 32 || !request.id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) ||
            request.sha256.len() != 64 || request.bytes > MAX_BYTES ||
            unsafe { (api.is_buffer)(env,args[3],&mut is_buffer) } != 0 || !is_buffer ||
            unsafe { (api.get_buffer)(env,args[3],&mut pointer,&mut length) } != 0 || length != request.bytes || length > MAX_BYTES ||
            (length > 0 && pointer.is_null()) { return Err(c"PRIVATE_STORAGE_UNAVAILABLE"); }
        let bytes = if length == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(),length) }.to_vec() };
        let entry = checked(&api,env,&args,state,true).map_err(|_| c"PRIVATE_STORAGE_UNAVAILABLE")?;
        if !entry.requests.insert(request.id.clone()) { return Err(c"PRIVATE_STORAGE_CHANGED"); }
        let observation = entry.lease.publish(&request.name,&request.id,&bytes,&request.sha256,request.expected.as_ref()).map_err(|error| match error {
            storage::Failure::BeforePublish => c"PRIVATE_STORAGE_UNAVAILABLE", storage::Failure::Changed => c"PRIVATE_STORAGE_CHANGED",
            storage::Failure::Unknown => c"PRIVATE_STORAGE_PUBLICATION_UNKNOWN",
        })?;
        if !napi::current_capture(env,args[0]) { return Err(c"PRIVATE_STORAGE_PUBLICATION_UNKNOWN"); }
        let metadata = serde_json::to_string(&Metadata { version: 1, status: "published", observation: Some(observation), payload_bytes: 0 })
            .map_err(|_| c"PRIVATE_STORAGE_PUBLICATION_UNKNOWN")?;
        api.text(env,&metadata).map_err(|_| c"PRIVATE_STORAGE_PUBLICATION_UNKNOWN")
    })(); result.unwrap_or_else(|code| api.error(env,code))
}
unsafe extern "C" fn close(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); }; let api = state.api;
    let result = (|| -> io::Result<Value> {
        let args = arguments(&api,env,info,2)?;
        // Closing the original held handles remains legal after image retirement.
        checked(&api,env,&args,state,false)?;
        if let Some(entry) = state.entries.remove(&api.pointer(env,args[1])?) {
            unsafe { (api.delete_reference)(env,entry.capture_reference as *mut c_void); }
        }
        let mut value = ptr::null_mut();
        if unsafe { (api.undefined)(env,&mut value) } != 0 { return Err(io::ErrorKind::Unsupported.into()); } Ok(value)
    })(); result.unwrap_or_else(|_| api.error(env,c"PRIVATE_STORAGE_UNAVAILABLE"))
}
fn diagnostic(stage: &'static str, error: io::Error) -> io::Error {
    eprintln!("PRIVATE_STORAGE_FAILURE stage={stage} kind={:?} os={}", error.kind(), error.raw_os_error().unwrap_or(0));
    error
}
fn cleanup_state(env: Env) {
    if let Ok(mut all) = states().lock() {
        if let Some(state) = all.remove(&(env as usize)) {
            for entry in state.entries.into_values() { unsafe { (state.api.delete_reference)(env,entry.capture_reference as *mut c_void); } }
        }
    }
}
unsafe extern "C" fn cleanup(env: *mut c_void) { cleanup_state(env); }
unsafe extern "C" fn finalize(env: Env, token: *mut c_void, _: *mut c_void) {
    if token.is_null() { return; }
    if let Ok(mut all) = states().lock() {
        if let Some(state) = all.get_mut(&(env as usize)) {
            if let Some(entry) = state.entries.remove(&(token as usize)) {
                unsafe { (state.api.delete_reference)(env,entry.capture_reference as *mut c_void); }
            }
        }
    }
    unsafe { drop(Box::from_raw(token.cast::<usize>())); }
}
