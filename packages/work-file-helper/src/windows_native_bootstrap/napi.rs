//! Node-API v8 declarations use the host's original exported symbols. No
//! node.lib/Electron import-library path or external binding is accepted at run time.
use super::{loader::FirstLoad, preload};
use std::{collections::HashMap, ffi::{c_char, c_void}, io, ptr, sync::{Mutex, OnceLock}};
type Env = *mut c_void;
type Value = *mut c_void;
type Callback = unsafe extern "C" fn(Env, *mut c_void) -> Value;
type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}

#[derive(Clone, Copy)]
struct Api {
    create_external: unsafe extern "C" fn(Env, *mut c_void, Option<Finalizer>, *mut c_void, *mut Value) -> i32,
    get_external: unsafe extern "C" fn(Env, Value, *mut *mut c_void) -> i32,
    create_function: unsafe extern "C" fn(Env, *const c_char, usize, Callback, *mut c_void, *mut Value) -> i32,
    set_property: unsafe extern "C" fn(Env, Value, *const c_char, Value) -> i32,
    get_cb_info: unsafe extern "C" fn(Env, *mut c_void, *mut usize, *mut Value, *mut Value, *mut *mut c_void) -> i32,
    create_string: unsafe extern "C" fn(Env, *const c_char, usize, *mut Value) -> i32,
    get_boolean: unsafe extern "C" fn(Env, bool, *mut Value) -> i32,
    get_undefined: unsafe extern "C" fn(Env, *mut Value) -> i32,
    throw_error: unsafe extern "C" fn(Env, *const c_char, *const c_char) -> i32,
    freeze: unsafe extern "C" fn(Env, Value) -> i32,
    get_uint32: unsafe extern "C" fn(Env, Value, *mut u32) -> i32,
    get_string: unsafe extern "C" fn(Env, Value, *mut c_char, usize, *mut usize) -> i32,
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
            create_function: symbol!("napi_create_function", unsafe extern "C" fn(Env,*const c_char,usize,Callback,*mut c_void,*mut Value)->i32),
            set_property: symbol!("napi_set_named_property", unsafe extern "C" fn(Env,Value,*const c_char,Value)->i32),
            get_cb_info: symbol!("napi_get_cb_info", unsafe extern "C" fn(Env,*mut c_void,*mut usize,*mut Value,*mut Value,*mut *mut c_void)->i32),
            create_string: symbol!("napi_create_string_utf8", unsafe extern "C" fn(Env,*const c_char,usize,*mut Value)->i32),
            get_boolean: symbol!("napi_get_boolean", unsafe extern "C" fn(Env,bool,*mut Value)->i32),
            get_undefined: symbol!("napi_get_undefined", unsafe extern "C" fn(Env,*mut Value)->i32),
            throw_error: symbol!("napi_throw_error", unsafe extern "C" fn(Env,*const c_char,*const c_char)->i32),
            freeze: symbol!("napi_object_freeze", unsafe extern "C" fn(Env,Value)->i32),
            get_uint32: symbol!("napi_get_value_uint32", unsafe extern "C" fn(Env,Value,*mut u32)->i32),
            get_string: symbol!("napi_get_value_string_utf8", unsafe extern "C" fn(Env,Value,*mut c_char,usize,*mut usize)->i32),
            cleanup: symbol!("napi_add_env_cleanup_hook", unsafe extern "C" fn(Env,unsafe extern "C" fn(*mut c_void),*mut c_void)->i32),
        })
    }
    fn error(&self, env: Env) -> Value {
        unsafe { (self.throw_error)(env, c"WINDOWS_FIRST_LOADER_UNAVAILABLE".as_ptr(), c"Original Windows native image capture is unavailable".as_ptr()); }
        ptr::null_mut()
    }
}

struct State { api: Api, token: usize, image: Option<FirstLoad>, preload: Option<preload::Evidence>, installation: Option<super::installation::Installed>, children: HashMap<usize, preload::Child>, sidecars: HashMap<usize, preload::Prepared> }
static STATES: OnceLock<Mutex<HashMap<usize, State>>> = OnceLock::new();
fn states() -> &'static Mutex<HashMap<usize, State>> { STATES.get_or_init(|| Mutex::new(HashMap::new())) }

/// No pointer received from another addon is ever dereferenced. Identity checks
/// also remain available after retirement so owned private leases can close.
pub fn same_capture(env: Env, value: Value) -> bool {
    let Ok(all) = states().lock() else { return false; };
    let Some(state) = all.get(&(env as usize)) else { return false; };
    let mut pointer = ptr::null_mut();
    (unsafe { (state.api.get_external)(env, value, &mut pointer) }) == 0 && !pointer.is_null() && pointer as usize == state.token
}

pub fn current_capture(env: Env, value: Value) -> bool {
    let Ok(all) = states().lock() else { return false; };
    let Some(state) = all.get(&(env as usize)) else { return false; };
    let mut pointer = ptr::null_mut();
    (unsafe { (state.api.get_external)(env, value, &mut pointer) }) == 0 && !pointer.is_null() && pointer as usize == state.token &&
        valid(state)
}

pub fn with_current_image<A>(env: Env, capture: Value, run: impl FnOnce(&FirstLoad) -> io::Result<A>) -> io::Result<A> {
    let all = states().lock().map_err(|_| io::ErrorKind::Other)?;
    let state = all.get(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
    let mut pointer = ptr::null_mut();
    if unsafe { (state.api.get_external)(env,capture,&mut pointer) } != 0 || pointer.is_null() || pointer as usize != state.token || state.preload.is_some() || !valid(state) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    run(state.image.as_ref().ok_or(io::ErrorKind::PermissionDenied)?)
}

pub fn with_preloaded_image<A>(env: Env, capture: Value, run: impl FnOnce(&FirstLoad, &preload::Evidence) -> io::Result<A>) -> io::Result<A> {
    let all = states().lock().map_err(|_| io::ErrorKind::Other)?;
    let state = all.get(&(env as usize)).ok_or(io::ErrorKind::PermissionDenied)?;
    let mut pointer = ptr::null_mut();
    if unsafe { (state.api.get_external)(env,capture,&mut pointer) } != 0 || pointer.is_null() ||
        pointer as usize != state.token { return Err(io::ErrorKind::PermissionDenied.into()); }
    let image = state.image.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
    let proof = state.preload.as_ref().ok_or(io::ErrorKind::PermissionDenied)?;
    // Every caller synchronously validates these original image/proof objects
    // before external I/O or authority use; keep the state lock held through run.
    run(image,proof)
}

pub fn register(env: Env, exports: Value, address: *const c_void) -> Value {
    let Ok(api) = Api::load() else { return ptr::null_mut(); };
    let result = (|| -> io::Result<()> {
        let image = FirstLoad::capture(address)?;
        let preload = preload::receive(&image)?;
        let token = Box::into_raw(Box::new(env as usize));
        let mut external = ptr::null_mut();
        if unsafe { (api.create_external)(env, token.cast(), Some(finalize), ptr::null_mut(), &mut external) } != 0 {
            unsafe { drop(Box::from_raw(token)); }
            return Err(io::ErrorKind::Unsupported.into());
        }
        let mut all = states().lock().map_err(|_| io::ErrorKind::Other)?;
        if all.contains_key(&(env as usize)) { return Err(io::ErrorKind::PermissionDenied.into()); }
        all.insert(env as usize, State { api, token: token as usize, image: Some(image), preload, installation: None, children: HashMap::new(), sidecars: HashMap::new() });
        drop(all);
        if unsafe { (api.cleanup)(env, cleanup, env) } != 0 || unsafe { (api.set_property)(env, exports, c"capture".as_ptr(), external) } != 0 {
            states().lock().map_err(|_| io::ErrorKind::Other)?.remove(&(env as usize));
            return Err(io::ErrorKind::Unsupported.into());
        }
        for (name, callback) in [(c"describe", describe as Callback), (c"current", current as Callback), (c"close", close as Callback), (c"preloaded", preloaded as Callback), (c"compiledCli",compiled_cli as Callback),
            (c"launchPreloadedNode", launch as Callback), (c"launchCli",launch_cli as Callback),(c"pollCli",poll_cli as Callback), (c"pollPreloadedNode", poll as Callback), (c"closePreloadedNode", close_child as Callback), (c"processBirth", process_birth as Callback),
            (c"prepareSidecar", prepare_sidecar as Callback), (c"bindSidecar", bind_sidecar as Callback),
            (c"closeSidecar", close_sidecar as Callback), (c"acceptPreload", accept_preload as Callback), (c"readInstallation", read_installation as Callback)] {
            let mut value = ptr::null_mut();
            if unsafe { (api.create_function)(env, name.as_ptr(), name.to_bytes().len(), callback, ptr::null_mut(), &mut value) } != 0 ||
                unsafe { (api.set_property)(env, exports, name.as_ptr(), value) } != 0 { return Err(io::ErrorKind::Unsupported.into()); }
        }
        super::windows_private_storage_bridge::register(env, exports)?;
        super::publisher_bridge::register(env, exports)?;
        super::work_bridge::register(env, exports)?;
        super::work_child_bridge::register(env, exports)?;
        super::work_command_bridge::register(env, exports)?;
        super::work_workspace_bridge::register(env, exports)?;
        super::work_command_cleanup_bridge::register(env, exports)?;
        super::event_git_bridge::register(env, exports)?;
        if unsafe { (api.freeze)(env, exports) } != 0 { return Err(io::ErrorKind::Unsupported.into()); }
        Ok(())
    })();
    if result.is_err() { states().lock().ok().map(|mut all| all.remove(&(env as usize))); return api.error(env); }
    exports
}

fn argument(api: &Api, env: Env, info: *mut c_void, token: usize) -> bool {
    let mut count = 2; let mut arguments = [ptr::null_mut(); 2]; let mut pointer = ptr::null_mut();
    (unsafe { (api.get_cb_info)(env, info, &mut count, arguments.as_mut_ptr(), ptr::null_mut(), ptr::null_mut()) }) == 0 && count == 1 &&
        (unsafe { (api.get_external)(env, arguments[0], &mut pointer) }) == 0 && !pointer.is_null() && pointer as usize == token
}

unsafe extern "C" fn describe(env: Env, info: *mut c_void) -> Value {
    let Ok(all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) { return state.api.error(env); }
    let Some(image) = &state.image else { return state.api.error(env); };
    if !valid(state) { return state.api.error(env); }
    let Ok(text) = encode_description(image, state.preload.as_ref()) else { return state.api.error(env); };
    let mut value = ptr::null_mut();
    if unsafe { (state.api.create_string)(env, text.as_ptr().cast(), text.len(), &mut value) } != 0 { return state.api.error(env); }
    value
}
/// Public immutable facts only. Callers must validate the same held image/proof
/// before returning this description; it never proves current authority itself.
pub(super) fn encode_description(image: &FirstLoad, proof: Option<&preload::Evidence>) -> io::Result<String> {
    let mut description = serde_json::to_value(image.description()).map_err(io::Error::other)?;
    description["preloaded"] = serde_json::Value::Bool(proof.is_some());
    description["preload_hash"] = proof.map(|proof| serde_json::Value::String(proof.hash.clone())).unwrap_or(serde_json::Value::Null);
    let text = serde_json::to_string(&description).map_err(io::Error::other)?;
    if text.len() > 65_536 { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(text)
}
unsafe extern "C" fn current(env: Env, info: *mut c_void) -> Value {
    let Ok(all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) { return state.api.error(env); }
    let valid = valid(state);
    let mut value = ptr::null_mut();
    if unsafe { (state.api.get_boolean)(env, valid, &mut value) } != 0 { return state.api.error(env); }
    value
}
unsafe extern "C" fn close(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) { return state.api.error(env); }
    if state.children.values().any(|child| child.stop().is_err()) ||
        state.sidecars.values_mut().any(|sidecar| sidecar.close().is_err()) { return state.api.error(env); }
    state.sidecars.clear();
    state.children.clear();
    state.installation = None;
    state.preload = None;
    state.image = None;
    let mut value = ptr::null_mut();
    if unsafe { (state.api.get_undefined)(env, &mut value) } != 0 { return state.api.error(env); }
    value
}
fn valid(state: &State) -> bool {
    state.image.as_ref().is_some_and(|image| image.current().is_ok()) &&
        state.preload.as_ref().is_none_or(|proof| proof.current().is_ok())
}
unsafe extern "C" fn preloaded(env: Env, info: *mut c_void) -> Value {
    let Ok(all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) { return state.api.error(env); }
    let mut value = ptr::null_mut();
    if unsafe { (state.api.get_boolean)(env, state.preload.is_some() && valid(state), &mut value) } != 0 { return state.api.error(env); }
    value
}
unsafe extern "C" fn compiled_cli(env:Env,info:*mut c_void)->Value {
    let Ok(all)=states().lock()else{return ptr::null_mut();};let Some(state)=all.get(&(env as usize))else{return ptr::null_mut();};
    if !argument(&state.api,env,info,state.token){return state.api.error(env);}
    let valid=valid(state)&&state.preload.as_ref().is_some_and(|proof|proof.artifact_name().ok()==Some("deepagent-code.exe"));
    let mut value=ptr::null_mut();if unsafe{(state.api.get_boolean)(env,valid,&mut value)}!=0{return state.api.error(env);}value
}
unsafe extern "C" fn launch(env:Env,info:*mut c_void)->Value{launch_fixed(env,info,false)}
unsafe extern "C" fn launch_cli(env:Env,info:*mut c_void)->Value{launch_fixed(env,info,true)}
fn launch_fixed(env: Env, info: *mut c_void,cli:bool) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) || !valid(state) || state.children.len() >= 4 || (cli&&state.preload.is_some()) { return state.api.error(env); }
    let Some(image) = &state.image else { return state.api.error(env); };
    let child = match if cli{preload::launch_cli(image)}else{preload::launch(image)} {
        Ok(child) => child,
        Err(error) => { eprintln!("dac-native-preload:launch:{:?}:{:?}", error.kind(), error.raw_os_error()); return state.api.error(env); }
    };
    let token = Box::into_raw(Box::new(env as usize));
    let mut value = ptr::null_mut();
    if unsafe { (state.api.create_external)(env, token.cast(), Some(finalize_child), ptr::null_mut(), &mut value) } != 0 {
        unsafe { drop(Box::from_raw(token)); }
        return state.api.error(env);
    }
    state.children.insert(token as usize, child);
    value
}
fn child_argument(state: &State, env: Env, info: *mut c_void) -> Option<usize> {
    let mut count = 3; let mut values = [ptr::null_mut(); 3]; let mut capture = ptr::null_mut(); let mut child = ptr::null_mut();
    if unsafe { (state.api.get_cb_info)(env, info, &mut count, values.as_mut_ptr(), ptr::null_mut(), ptr::null_mut()) } != 0 || count != 2 ||
        unsafe { (state.api.get_external)(env, values[0], &mut capture) } != 0 || capture as usize != state.token ||
        unsafe { (state.api.get_external)(env, values[1], &mut child) } != 0 || child.is_null() || !state.children.contains_key(&(child as usize)) {
        return None;
    }
    Some(child as usize)
}
unsafe extern "C" fn poll(env: Env, info: *mut c_void) -> Value {
    let Ok(all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get(&(env as usize)) else { return ptr::null_mut(); };
    let Some(token) = child_argument(state, env, info) else { return state.api.error(env); };
    let Some(child) = state.children.get(&token) else { return state.api.error(env); };
    let Ok(done) = child.poll() else { return state.api.error(env); };
    let mut value = ptr::null_mut();
    if unsafe { (state.api.get_boolean)(env, done, &mut value) } != 0 { return state.api.error(env); }
    value
}
unsafe extern "C" fn poll_cli(env:Env,info:*mut c_void)->Value {
    let Ok(all)=states().lock()else{return ptr::null_mut();};let Some(state)=all.get(&(env as usize))else{return ptr::null_mut();};
    let Some(token)=child_argument(state,env,info)else{return state.api.error(env);};let Some(child)=state.children.get(&token)else{return state.api.error(env);};
    let status=match child.cli_status(){Ok(value)=>value,Err(_)=>return state.api.error(env)};
    native_string(state,env,&serde_json::json!({"version":1,"running":status.is_none(),"exit_code":status,"tree_retired":status.is_some()}).to_string())
}
unsafe extern "C" fn close_child(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    let Some(token) = child_argument(state, env, info) else { return state.api.error(env); };
    let Some(child) = state.children.remove(&token) else { return state.api.error(env); };
    if child.stop().is_err() { state.children.insert(token, child); return state.api.error(env); }
    drop(child);
    let mut value = ptr::null_mut();
    if unsafe { (state.api.get_undefined)(env, &mut value) } != 0 { return state.api.error(env); }
    value
}
unsafe extern "C" fn finalize_child(env: Env, token: *mut c_void, _: *mut c_void) {
    if token.is_null() { return; }
    if let Ok(mut all) = states().lock() {
        if let Some(state) = all.get_mut(&(env as usize)) {
            if state.children.get(&(token as usize)).is_some_and(|child|child.stop().is_err()) { return; }
            state.children.remove(&(token as usize));
        }
    }
    unsafe { drop(Box::from_raw(token.cast::<usize>())); }
}
fn string(api: &Api, env: Env, value: Value, limit: usize) -> io::Result<String> {
    let mut size = 0;
    if unsafe { (api.get_string)(env, value, ptr::null_mut(), 0, &mut size) } != 0 || size == 0 || size > limit { return Err(io::ErrorKind::InvalidData.into()); }
    let mut bytes = vec![0u8; size + 1]; let mut copied = 0;
    if unsafe { (api.get_string)(env, value, bytes.as_mut_ptr().cast(), bytes.len(), &mut copied) } != 0 || copied != size || bytes[..size].contains(&0) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    bytes.truncate(size); String::from_utf8(bytes).map_err(io::Error::other)
}
fn args(state: &State, env: Env, info: *mut c_void, count: usize) -> io::Result<Vec<Value>> {
    let mut size = count + 1; let mut values = vec![ptr::null_mut(); size]; let mut capture = ptr::null_mut();
    if unsafe { (state.api.get_cb_info)(env, info, &mut size, values.as_mut_ptr(), ptr::null_mut(), ptr::null_mut()) } != 0 || size != count ||
        unsafe { (state.api.get_external)(env, values[0], &mut capture) } != 0 || capture as usize != state.token { return Err(io::ErrorKind::PermissionDenied.into()); }
    values.truncate(count); Ok(values)
}
fn native_string(state: &State, env: Env, text: &str) -> Value {
    let mut value = ptr::null_mut();
    if unsafe { (state.api.create_string)(env, text.as_ptr().cast(), text.len(), &mut value) } != 0 { return state.api.error(env); }
    value
}
unsafe extern "C" fn process_birth(env: Env, info: *mut c_void) -> Value {
    let Ok(all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) || !valid(state) { return state.api.error(env); }
    let Ok(birth) = preload::birth(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() }) else { return state.api.error(env); };
    native_string(state, env, &birth)
}
unsafe extern "C" fn prepare_sidecar(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) || !valid(state) || state.sidecars.len() >= 4 { return state.api.error(env); }
    let Some(image) = &state.image else { return state.api.error(env); };
    let prepared = match preload::prepare_sidecar(image) { Ok(value) => value, Err(error) => {
        eprintln!("dac-native-preload:prepare-sidecar:{:?}:{:?}", error.kind(), error.raw_os_error()); return state.api.error(env);
    }};
    let token = Box::into_raw(Box::new(env as usize)); let mut value = ptr::null_mut();
    if unsafe { (state.api.create_external)(env, token.cast(), Some(finalize_sidecar), ptr::null_mut(), &mut value) } != 0 {
        unsafe { drop(Box::from_raw(token)); } return state.api.error(env);
    }
    state.sidecars.insert(token as usize, prepared); value
}
unsafe extern "C" fn bind_sidecar(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    let Ok(values) = args(state, env, info, 4) else { return state.api.error(env); };
    if !valid(state) { return state.api.error(env); }
    let mut pointer = ptr::null_mut(); let mut pid = 0;
    if unsafe { (state.api.get_external)(env, values[1], &mut pointer) } != 0 || pointer.is_null() ||
        unsafe { (state.api.get_uint32)(env, values[2], &mut pid) } != 0 { return state.api.error(env); }
    let Ok(birth) = string(&state.api, env, values[3], 16) else { return state.api.error(env); };
    let Some(prepared) = state.sidecars.get_mut(&(pointer as usize)) else { return state.api.error(env); };
    let marker = match prepared.bind(pid, &birth) { Ok(marker) => marker, Err(error) => {
        eprintln!("dac-native-preload:bind-sidecar:{:?}:{:?}", error.kind(), error.raw_os_error()); return state.api.error(env);
    }};
    native_string(state, env, &marker)
}
unsafe extern "C" fn close_sidecar(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    let Ok(values) = args(state, env, info, 2) else { return state.api.error(env); };
    let mut pointer = ptr::null_mut();
    if unsafe { (state.api.get_external)(env, values[1], &mut pointer) } != 0 || pointer.is_null() { return state.api.error(env); }
    let Some(prepared) = state.sidecars.get_mut(&(pointer as usize)) else { return state.api.error(env); };
    if let Err(error) = prepared.close() {
        eprintln!("dac-native-preload:close-sidecar:{:?}:{:?}", error.kind(), error.raw_os_error());
        return state.api.error(env);
    }
    state.sidecars.remove(&(pointer as usize)); let mut value = ptr::null_mut();
    if unsafe { (state.api.get_undefined)(env, &mut value) } != 0 { return state.api.error(env); } value
}
unsafe extern "C" fn accept_preload(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    let Ok(values) = args(state, env, info, 2) else { return state.api.error(env); };
    if state.preload.is_some() || !valid(state) { return state.api.error(env); }
    let Ok(marker) = string(&state.api, env, values[1], 128) else { return state.api.error(env); };
    let Some(image) = &state.image else { return state.api.error(env); };
    let proof = match preload::accept(image, &marker) { Ok(proof) => proof, Err(error) => {
        eprintln!("dac-native-preload:accept:{:?}:{:?}", error.kind(), error.raw_os_error()); return state.api.error(env);
    }};
    state.preload = Some(proof); let mut value = ptr::null_mut();
    if unsafe { (state.api.get_boolean)(env, true, &mut value) } != 0 { return state.api.error(env); } value
}
unsafe extern "C" fn finalize_sidecar(env: Env, token: *mut c_void, _: *mut c_void) {
    if token.is_null() { return; }
    if let Ok(mut all) = states().lock() { if let Some(state) = all.get_mut(&(env as usize)) { state.sidecars.remove(&(token as usize)); } }
    unsafe { drop(Box::from_raw(token.cast::<usize>())); }
}
unsafe extern "C" fn read_installation(env: Env, info: *mut c_void) -> Value {
    let Ok(mut all) = states().lock() else { return ptr::null_mut(); };
    let Some(state) = all.get_mut(&(env as usize)) else { return ptr::null_mut(); };
    if !argument(&state.api, env, info, state.token) { return state.api.error(env); }
    let (Some(image), Some(proof)) = (&state.image, &state.preload) else { return state.api.error(env); };
    // open/read check this same held image and preload before using them. Keep
    // their full checks instead of repeating the graph here in this sync call.
    if state.installation.is_none() {
        let installed = match super::installation::Installed::open(image, proof) { Ok(value) => value, Err(error) => {
            eprintln!("dac-native-preload:installation-open:{:?}:{:?}", error.kind(), error.raw_os_error()); return state.api.error(env);
        }};
        state.installation = Some(installed);
    }
    let Some(installed) = &state.installation else { return state.api.error(env); };
    let text = match installed.read(image, proof) { Ok(value) => value, Err(error) => {
        eprintln!("dac-native-preload:installation-read:{:?}:{:?}", error.kind(), error.raw_os_error()); return state.api.error(env);
    }};
    native_string(state, env, &text)
}
unsafe extern "C" fn cleanup(env: *mut c_void) { states().lock().ok().map(|mut all| all.remove(&(env as usize))); }
unsafe extern "C" fn finalize(env: Env, token: *mut c_void, _: *mut c_void) {
    if token.is_null() { return; }
    if let Ok(mut all) = states().lock() {
        if all.get(&(env as usize)).is_some_and(|state| state.token == token as usize) { all.remove(&(env as usize)); }
    }
    unsafe { drop(Box::from_raw(token.cast::<usize>())); }
}
