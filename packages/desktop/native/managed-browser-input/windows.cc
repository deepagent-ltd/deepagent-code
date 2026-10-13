#define WIN32_LEAN_AND_MEAN
#define CINTERFACE
#include <windows.h>
#include <msctf.h>
#include <node_api.h>
#include <stddef.h>

// Candidate only. The fixed publisher must qualify the real current TSF objects,
// child windows, native IME and CDP separation before selecting this asset.
// No process/window/text authority is returned to JavaScript.
static constexpr unsigned capacity = 16;
struct Owner;
struct Watch {
  Owner* owner;
  napi_env env;
  napi_ref callback;
  HWND root;
  HWND children[capacity];
  WNDPROC procedures[capacity + 1];
  unsigned childrenCount;
  unsigned refs;
  bool released;
  bool invalid;
};
struct Context {
  ITfDocumentMgr* document;
  ITfContext* context;
  ITfSource* source;
  DWORD cookie;
  bool advised;
};
struct Sink {
  ITfThreadMgrEventSink thread;
  ITfTextEditSink edit;
  Owner* owner;
  ULONG refs;
};
struct Owner {
  napi_env env;
  DWORD thread;
  DWORD process;
  bool initialized;
  bool closed;
  bool invalid;
  bool closing;
  bool stopPending;
  volatile LONG foreignCallback;
  unsigned callbackDepth;
  HMODULE managerModule;
  HHOOK queued;
  HHOOK sent;
  ITfThreadMgr* manager;
  ITfSource* source;
  DWORD cookie;
  bool threadAdvised;
  bool unknownRegistration;
  Context contexts[capacity];
  unsigned contextsCount;
  Watch* watches[capacity];
  Sink sink;
  unsigned hooksInstalled;
  unsigned hooksRemoved;
  unsigned advises;
  unsigned unadvises;
  unsigned cleanupFailures;
  unsigned callbacks;
};
// A single Main environment/UI thread. Tombstoned COM sinks outlive environment
// cleanup if the OS refuses Unadvise; they never invoke a retired napi_env.
static Owner owner{};
static void release(Watch*);
static bool stop(Owner*);

static ULONG references(Sink* value) {
  return static_cast<ULONG>(InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(&value->refs), 0, 0));
}
static bool bytesEqual(const char* a, const char* b) {
  while (*a && *a == *b) { ++a; ++b; }
  return *a == *b;
}
static bool property(napi_env env, napi_value object, const char* key, const char* expected) {
  napi_value value;
  char text[64];
  size_t size = 0;
  return napi_get_named_property(env, object, key, &value) == napi_ok &&
    napi_get_value_string_utf8(env, value, text, sizeof(text), &size) == napi_ok &&
    size < sizeof(text) && bytesEqual(text, expected);
}
static bool runtime(napi_env env) {
  napi_value global, process, versions;
  return napi_get_global(env, &global) == napi_ok &&
    napi_get_named_property(env, global, "process", &process) == napi_ok &&
    property(env, process, "platform", "win32") && property(env, process, "arch", "x64") &&
    property(env, process, "type", "browser") &&
    napi_get_named_property(env, process, "versions", &versions) == napi_ok &&
    property(env, versions, "electron", "41.10.3") && property(env, versions, "node", "24.18.0");
}
static void retain(Watch* watch) { ++watch->refs; }
static void drop(Watch* watch) {
  if (--watch->refs == 0) HeapFree(GetProcessHeap(), 0, watch);
}
static bool uiThread(const Owner* value) {
  return value->thread == GetCurrentThreadId() && value->process == GetCurrentProcessId();
}
static bool sameThread(Owner* value) {
  return uiThread(value) && !value->closed &&
    InterlockedCompareExchange(&value->foreignCallback, 0, 0) == 0;
}
struct Callback {
  Owner* value;
  bool entered;
  explicit Callback(Owner* item) : value(item), entered(uiThread(item)) {
    if (!entered) { InterlockedExchange(&item->foreignCallback, 1); return; }
    ++value->callbackDepth;
  }
  ~Callback() {
    if (!entered) return;
    --value->callbackDepth;
    if (!value->callbackDepth && value->stopPending) {
      value->stopPending = false;
      stop(value);
    }
  }
};
static bool belongs(const Watch* watch, HWND window) {
  if (window == watch->root) return true;
  for (unsigned i = 0; i < watch->childrenCount; ++i) if (watch->children[i] == window) return true;
  return false;
}
static void signal(Watch* watch) {
  if (watch->released || !sameThread(watch->owner) || !watch->callback) return;
  retain(watch);
  napi_handle_scope scope;
  if (napi_open_handle_scope(watch->env, &scope) != napi_ok) {
    watch->invalid = true;
    drop(watch);
    return;
  }
  napi_value callback, global, result;
  const bool called = napi_get_reference_value(watch->env, watch->callback, &callback) == napi_ok &&
    napi_get_global(watch->env, &global) == napi_ok &&
    napi_call_function(watch->env, global, callback, 0, nullptr, &result) == napi_ok;
  bool promise = false;
  if (!called || napi_is_promise(watch->env, result, &promise) != napi_ok || promise) {
    watch->invalid = true;
    bool pending = false;
    if (napi_is_exception_pending(watch->env, &pending) == napi_ok && pending) {
      napi_value error;
      napi_get_and_clear_last_exception(watch->env, &error);
    }
  }
  ++watch->owner->callbacks;
  if (napi_close_handle_scope(watch->env, scope) != napi_ok) watch->invalid = true;
  drop(watch);
}
static void invalidate(Owner* value) {
  value->invalid = true;
  if (!sameThread(value)) return;
  for (unsigned i = 0; i < capacity; ++i) if (value->watches[i]) {
    value->watches[i]->invalid = true;
    signal(value->watches[i]);
  }
}
static bool contextWindow(ITfContext* context, HWND* window) {
  *window = nullptr;
  if (!context) return false;
  ITfContextView* view = nullptr;
  const HRESULT current = context->lpVtbl->GetActiveView(context, &view);
  if (FAILED(current) || !view) {
    if (view) view->lpVtbl->Release(view);
    return false;
  }
  const HRESULT result = view->lpVtbl->GetWnd(view, window);
  view->lpVtbl->Release(view);
  return SUCCEEDED(result);
}
static void signalWindow(Owner* value, HWND window, bool changed = false) {
  if (!sameThread(value) || value->closing) return;
  for (unsigned i = 0; i < capacity; ++i) {
    Watch* watch = value->watches[i];
    if (!watch || !belongs(watch, window)) continue;
    if (changed) watch->invalid = true;
    signal(watch);
  }
}
static bool inputMessage(UINT message) {
  switch (message) {
    case WM_KEYDOWN: case WM_KEYUP: case WM_SYSKEYDOWN: case WM_SYSKEYUP:
    case WM_CHAR: case WM_SYSCHAR: case WM_DEADCHAR: case WM_SYSDEADCHAR:
    case WM_UNICHAR: case WM_IME_STARTCOMPOSITION: case WM_IME_COMPOSITION:
    case WM_IME_ENDCOMPOSITION: case WM_IME_CHAR: case WM_IME_KEYDOWN:
    case WM_IME_KEYUP: case WM_IME_NOTIFY: case WM_IME_REQUEST:
    case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_LBUTTONDBLCLK:
    case WM_RBUTTONDOWN: case WM_RBUTTONUP: case WM_RBUTTONDBLCLK:
    case WM_MBUTTONDOWN: case WM_MBUTTONUP: case WM_MBUTTONDBLCLK:
    case WM_XBUTTONDOWN: case WM_XBUTTONUP: case WM_XBUTTONDBLCLK:
    case WM_MOUSEMOVE: case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
    case WM_POINTERDOWN: case WM_POINTERUP: case WM_POINTERUPDATE:
    case WM_TOUCH: case WM_GESTURE: return true;
    default: return false;
  }
}
static void message(HWND window, UINT type, WPARAM parameter) {
  if (owner.closed || owner.closing) return;
  if (inputMessage(type)) signalWindow(&owner, window);
  if (type == WM_NCDESTROY || type == WM_DESTROY ||
      (type == WM_PARENTNOTIFY && (LOWORD(parameter) == WM_CREATE || LOWORD(parameter) == WM_DESTROY)))
    signalWindow(&owner, window, true);
}
static LRESULT CALLBACK queued(int code, WPARAM parameter, LPARAM data) {
  Callback callback(&owner);
  if (callback.entered && code >= 0 && parameter == PM_REMOVE && data) {
    const MSG* event = reinterpret_cast<const MSG*>(data);
    message(event->hwnd, event->message, event->wParam);
  }
  return CallNextHookEx(nullptr, code, parameter, data);
}
static LRESULT CALLBACK sent(int code, WPARAM parameter, LPARAM data) {
  Callback callback(&owner);
  if (callback.entered && code >= 0 && data) {
    const CWPSTRUCT* event = reinterpret_cast<const CWPSTRUCT*>(data);
    message(event->hwnd, event->message, event->wParam);
  }
  return CallNextHookEx(nullptr, code, parameter, data);
}
static Sink* fromThread(ITfThreadMgrEventSink* value) {
  return reinterpret_cast<Sink*>(reinterpret_cast<char*>(value) - offsetof(Sink, thread));
}
static Sink* fromEdit(ITfTextEditSink* value) {
  return reinterpret_cast<Sink*>(reinterpret_cast<char*>(value) - offsetof(Sink, edit));
}
static HRESULT query(Sink* sink, REFIID iid, void** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, IID_ITfThreadMgrEventSink)) *result = &sink->thread;
  if (IsEqualIID(iid, IID_ITfTextEditSink)) *result = &sink->edit;
  if (!*result) return E_NOINTERFACE;
  InterlockedIncrement(reinterpret_cast<volatile LONG*>(&sink->refs));
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE threadQuery(ITfThreadMgrEventSink* value, REFIID iid, void** result) {
  return query(fromThread(value), iid, result);
}
static ULONG STDMETHODCALLTYPE threadAdd(ITfThreadMgrEventSink* value) {
  return InterlockedIncrement(reinterpret_cast<volatile LONG*>(&fromThread(value)->refs));
}
static ULONG STDMETHODCALLTYPE threadRelease(ITfThreadMgrEventSink* value) {
  return InterlockedDecrement(reinterpret_cast<volatile LONG*>(&fromThread(value)->refs));
}
static HRESULT STDMETHODCALLTYPE editQuery(ITfTextEditSink* value, REFIID iid, void** result) {
  return query(fromEdit(value), iid, result);
}
static ULONG STDMETHODCALLTYPE editAdd(ITfTextEditSink* value) {
  return InterlockedIncrement(reinterpret_cast<volatile LONG*>(&fromEdit(value)->refs));
}
static ULONG STDMETHODCALLTYPE editRelease(ITfTextEditSink* value) {
  return InterlockedDecrement(reinterpret_cast<volatile LONG*>(&fromEdit(value)->refs));
}
static bool captured(Owner* value, ITfDocumentMgr* document, ITfContext* context = nullptr) {
  for (unsigned i = 0; i < value->contextsCount; ++i)
    if (value->contexts[i].document == document && (!context || value->contexts[i].context == context)) return true;
  return false;
}
static void changedDocument(Owner* value, ITfDocumentMgr* document) {
  if (value->closed || value->closing) return;
  if (captured(value, document)) { invalidate(value); return; }
  ITfContext* context = nullptr;
  if (!document || FAILED(document->lpVtbl->GetTop(document, &context))) { invalidate(value); return; }
  HWND window = nullptr;
  const bool observed = context && contextWindow(context, &window);
  if (!observed) invalidate(value);
  if (observed) signalWindow(value, window, true);
  if (context) context->lpVtbl->Release(context);
}
static HRESULT STDMETHODCALLTYPE documentInit(ITfThreadMgrEventSink* sink, ITfDocumentMgr*) {
  Owner* value = fromThread(sink)->owner;
  Callback callback(value);
  if (callback.entered && !value->closed && !value->closing) invalidate(value);
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE documentUninit(ITfThreadMgrEventSink* sink, ITfDocumentMgr* document) {
  Owner* value = fromThread(sink)->owner;
  Callback callback(value);
  if (callback.entered) changedDocument(value, document);
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE focusChanged(ITfThreadMgrEventSink* sink, ITfDocumentMgr* focus, ITfDocumentMgr*) {
  Owner* value = fromThread(sink)->owner;
  Callback callback(value);
  if (!callback.entered || value->closed || value->closing) return S_OK;
  // Chromium reuses its per-input-type contexts between windows. A known focus
  // switch is not human input and must not retire another window's references.
  if (focus && !captured(value, focus)) changedDocument(value, focus);
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE contextChanged(ITfThreadMgrEventSink* sink, ITfContext*) {
  Owner* value = fromThread(sink)->owner;
  Callback callback(value);
  if (!callback.entered || value->closed || value->closing) return S_OK;
  // A push/pop changes the captured TSF stack, including a formerly empty NONE
  // document. Never acquire the replacement context under an existing lease.
  invalidate(value);
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE edited(ITfTextEditSink* sink, ITfContext* context, TfEditCookie, ITfEditRecord*) {
  Owner* value = fromEdit(sink)->owner;
  Callback callback(value);
  if (!callback.entered || value->closed || value->closing) return S_OK;
  bool known = false;
  for (unsigned i = 0; i < value->contextsCount; ++i) if (value->contexts[i].context == context) known = true;
  HWND window = nullptr;
  if (!known || !contextWindow(context, &window)) { invalidate(value); return S_OK; }
  signalWindow(value, window);
  return S_OK;
}
static const ITfThreadMgrEventSinkVtbl threadMethods = {
  threadQuery, threadAdd, threadRelease, documentInit, documentUninit, focusChanged, contextChanged, contextChanged,
};
static const ITfTextEditSinkVtbl editMethods = { editQuery, editAdd, editRelease, edited };

struct Census { Watch* watch; unsigned count; bool valid; bool capture; };
static bool windowIdentity(Watch* watch, HWND window, WNDPROC* procedure) {
  DWORD process = 0;
  const DWORD thread = GetWindowThreadProcessId(window, &process);
  if (!IsWindow(window) || process != watch->owner->process || thread != watch->owner->thread) return false;
  const auto current = reinterpret_cast<WNDPROC>(GetWindowLongPtrW(window, GWLP_WNDPROC));
  HMODULE image = nullptr;
  if (!current || !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(current), &image) || image != GetModuleHandleW(nullptr)) return false;
  *procedure = current;
  return true;
}
static BOOL CALLBACK child(HWND window, LPARAM parameter) {
  auto* census = reinterpret_cast<Census*>(parameter);
  if (census->count >= capacity) { census->valid = false; return FALSE; }
  WNDPROC procedure = nullptr;
  if (!windowIdentity(census->watch, window, &procedure)) { census->valid = false; return FALSE; }
  const unsigned i = census->count++;
  if (census->capture) {
    census->watch->children[i] = window; census->watch->procedures[i + 1] = procedure;
    return TRUE;
  }
  if (census->watch->children[i] != window || census->watch->procedures[i + 1] != procedure) {
    census->valid = false; return FALSE;
  }
  return TRUE;
}
static bool windowsCurrent(Watch* watch, bool capture = false) {
  WNDPROC root = nullptr;
  if (!windowIdentity(watch, watch->root, &root)) return false;
  if (capture) watch->procedures[0] = root;
  if (watch->procedures[0] != root) return false;
  Census census{watch, 0, true, capture};
  EnumChildWindows(watch->root, child, reinterpret_cast<LPARAM>(&census));
  if (!census.valid) return false;
  if (capture) watch->childrenCount = census.count;
  return watch->childrenCount == census.count;
}
static bool contextsCurrent(Watch* watch) {
  Owner* value = watch->owner;
  using GetManager = HRESULT(WINAPI*)(ITfThreadMgr**);
  HMODULE module = GetModuleHandleW(L"msctf.dll");
  auto get = module ? reinterpret_cast<GetManager>(GetProcAddress(module, "TF_GetThreadMgr")) : nullptr;
  if (module != value->managerModule || !get) return false;
  ITfThreadMgr* manager = nullptr;
  const HRESULT active = get(&manager);
  IUnknown* original = nullptr;
  IUnknown* current = nullptr;
  const bool same = SUCCEEDED(active) && manager &&
    SUCCEEDED(value->manager->lpVtbl->QueryInterface(value->manager, IID_IUnknown, reinterpret_cast<void**>(&original))) && original &&
    SUCCEEDED(manager->lpVtbl->QueryInterface(manager, IID_IUnknown, reinterpret_cast<void**>(&current))) && current && current == original;
  if (current) current->lpVtbl->Release(current);
  if (original) original->lpVtbl->Release(original);
  if (manager) manager->lpVtbl->Release(manager);
  if (!same) return false;
  IEnumTfDocumentMgrs* documents = nullptr;
  if (FAILED(value->manager->lpVtbl->EnumDocumentMgrs(value->manager, &documents)) || !documents) return false;
  unsigned seen = 0;
  unsigned identities = 0;
  bool valid = true;
  for (;;) {
    ITfDocumentMgr* document = nullptr;
    ULONG count = 0;
    const HRESULT next = documents->lpVtbl->Next(documents, 1, &document, &count);
    if (next == S_FALSE && count == 0) break;
    if (FAILED(next) || count != 1 || !document || seen >= value->contextsCount) {
      if (document) document->lpVtbl->Release(document);
      valid = false; break;
    }
    unsigned index = 0;
    while (index < value->contextsCount && value->contexts[index].document != document) ++index;
    if (index == value->contextsCount || (identities & (1u << index))) {
      document->lpVtbl->Release(document); valid = false; break;
    }
    identities |= 1u << index; ++seen;
    // Preserve the exact set, without assuming EnumDocumentMgrs ordering is a
    // lifetime contract. Unknown or duplicate COM identities close the lease.
    const Context* item = &value->contexts[index];
    ITfContext* top = nullptr;
    ITfContext* base = nullptr;
    valid = document == item->document && SUCCEEDED(document->lpVtbl->GetTop(document, &top)) && top == item->context &&
      SUCCEEDED(document->lpVtbl->GetBase(document, &base)) && base == top;
    HWND window = nullptr;
    if (valid && top) valid = contextWindow(top, &window);
    if (base) base->lpVtbl->Release(base);
    if (top) top->lpVtbl->Release(top);
    document->lpVtbl->Release(document);
    if (!valid) break;
  }
  documents->lpVtbl->Release(documents);
  if (!valid || seen != value->contextsCount) return false;
  ITfDocumentMgr* focus = nullptr;
  const HRESULT result = value->manager->lpVtbl->GetFocus(value->manager, &focus);
  valid = SUCCEEDED(result) && (!focus || captured(value, focus));
  if (focus) focus->lpVtbl->Release(focus);
  return valid;
}
static bool current(Watch* watch) {
  if (watch->released || watch->invalid || watch->owner->invalid || !sameThread(watch->owner) ||
      !watch->owner->queued || !watch->owner->sent || !watch->owner->manager) return false;
  Callback lifetime(watch->owner);
  if (!lifetime.entered) return false;
  if (windowsCurrent(watch) && contextsCurrent(watch) && !watch->released && !watch->invalid &&
      !watch->owner->invalid && sameThread(watch->owner) && windowsCurrent(watch)) return true;
  watch->invalid = true;
  return false;
}
static bool stop(Owner* value) {
  if (value->callbackDepth) { value->stopPending = true; return true; }
  value->closing = true;
  bool stopped = !value->unknownRegistration;
  HHOOK* hooks[] = { &value->queued, &value->sent };
  for (HHOOK* hook : hooks) if (*hook) {
    if (UnhookWindowsHookEx(*hook)) { *hook = nullptr; ++value->hooksRemoved; }
    else { stopped = false; ++value->cleanupFailures; }
  }
  for (unsigned i = 0; i < value->contextsCount; ++i) {
    Context* item = &value->contexts[i];
    if (item->source && item->advised && item->cookie != TF_INVALID_COOKIE) {
      if (FAILED(item->source->lpVtbl->UnadviseSink(item->source, item->cookie))) {
        stopped = false; ++value->cleanupFailures; continue;
      }
      item->cookie = TF_INVALID_COOKIE; item->advised = false; ++value->unadvises;
    }
    if (item->source) item->source->lpVtbl->Release(item->source);
    if (item->context) item->context->lpVtbl->Release(item->context);
    if (item->document) item->document->lpVtbl->Release(item->document);
    *item = {};
  }
  if (value->source && value->threadAdvised && value->cookie != TF_INVALID_COOKIE) {
    if (FAILED(value->source->lpVtbl->UnadviseSink(value->source, value->cookie))) {
      stopped = false; ++value->cleanupFailures;
    } else { value->cookie = TF_INVALID_COOKIE; value->threadAdvised = false; ++value->unadvises; }
  }
  if (stopped) {
    value->contextsCount = 0;
    if (value->source) value->source->lpVtbl->Release(value->source);
    if (value->manager) value->manager->lpVtbl->Release(value->manager);
    value->source = nullptr; value->manager = nullptr;
    // A known context/window epoch can be captured anew only after every old
    // watch has retired and all owned OS registrations acknowledged cleanup.
    // Old result objects keep released=true; they never adopt these new objects.
    if (!value->closed && !value->cleanupFailures &&
        InterlockedCompareExchange(&value->foreignCallback, 0, 0) == 0 && references(&value->sink) == 1)
      value->invalid = false;
  }
  value->closing = false;
  if (!stopped) value->invalid = true;
  return stopped;
}
static bool start(Owner* value) {
  if (value->invalid || value->closed || value->callbackDepth != 1 || value->stopPending || !sameThread(value)) return false;
  if (value->manager) return value->queued && value->sent;
  // A callback/foreign COM owner can retain the tombstone past Unadvise. Never
  // reset its reference count or rebind that same Sink to a new registration.
  if (references(&value->sink) != 0 && references(&value->sink) != 1) return false;
  using GetManager = HRESULT(WINAPI*)(ITfThreadMgr**);
  HMODULE module = GetModuleHandleW(L"msctf.dll");
  auto get = module ? reinterpret_cast<GetManager>(GetProcAddress(module, "TF_GetThreadMgr")) : nullptr;
  if (!get) return false;
  const HRESULT existing = get(&value->manager);
  if (FAILED(existing) || !value->manager) {
    if (value->manager) value->manager->lpVtbl->Release(value->manager);
    value->manager = nullptr;
    return false;
  }
  value->managerModule = module;
  value->cookie = TF_INVALID_COOKIE;
  value->sink = {{ &threadMethods }, { &editMethods }, value, 1};
  if (FAILED(value->manager->lpVtbl->QueryInterface(value->manager, IID_ITfSource,
      reinterpret_cast<void**>(&value->source))) || !value->source) { stop(value); return false; }
  const HRESULT threadRegistration = value->source->lpVtbl->AdviseSink(value->source, IID_ITfThreadMgrEventSink,
      reinterpret_cast<IUnknown*>(&value->sink.thread), &value->cookie);
  if (FAILED(threadRegistration) || value->cookie == TF_INVALID_COOKIE) {
    // A successful advise requires its own acknowledged cookie. An unexpected
    // non-invalid cookie on failure is not authority to unadvise another sink.
    if (SUCCEEDED(threadRegistration) || value->cookie != TF_INVALID_COOKIE) {
      value->unknownRegistration = true; value->invalid = true; ++value->cleanupFailures;
    }
    stop(value); return false;
  }
  value->threadAdvised = true; ++value->advises;
  IEnumTfDocumentMgrs* documents = nullptr;
  if (FAILED(value->manager->lpVtbl->EnumDocumentMgrs(value->manager, &documents)) || !documents) {
    stop(value); return false;
  }
  bool complete = true;
  for (;;) {
    ITfDocumentMgr* document = nullptr;
    ULONG count = 0;
    const HRESULT next = documents->lpVtbl->Next(documents, 1, &document, &count);
    if (next == S_FALSE && count == 0) break;
    if (FAILED(next) || count != 1 || !document || value->contextsCount >= capacity) {
      if (document) document->lpVtbl->Release(document);
      complete = false; break;
    }
    Context* item = &value->contexts[value->contextsCount++];
    *item = {document, nullptr, nullptr, TF_INVALID_COOKIE, false};
    // Preserve Chromium's original sink and per-input-type context. Empty NONE
    // documents are counted; a subsequent unknown PushContext invalidates them.
    if (FAILED(document->lpVtbl->GetTop(document, &item->context))) { complete = false; break; }
    if (!item->context) continue;
    ITfContext* base = nullptr;
    const HRESULT bottom = document->lpVtbl->GetBase(document, &base);
    const bool single = SUCCEEDED(bottom) && base == item->context;
    if (base) base->lpVtbl->Release(base);
    if (!single) { complete = false; break; }
    if (FAILED(item->context->lpVtbl->QueryInterface(item->context, IID_ITfSource,
        reinterpret_cast<void**>(&item->source))) || !item->source) { complete = false; break; }
    const HRESULT contextRegistration = item->source->lpVtbl->AdviseSink(item->source, IID_ITfTextEditSink,
      reinterpret_cast<IUnknown*>(&value->sink.edit), &item->cookie);
    if (FAILED(contextRegistration) || item->cookie == TF_INVALID_COOKIE) {
      if (SUCCEEDED(contextRegistration) || item->cookie != TF_INVALID_COOKIE) {
        value->unknownRegistration = true; value->invalid = true; ++value->cleanupFailures;
      }
      complete = false; break;
    }
    item->advised = true; ++value->advises;
  }
  documents->lpVtbl->Release(documents);
  if (!complete || !value->contextsCount || value->invalid) { stop(value); return false; }
  value->queued = SetWindowsHookExW(WH_GETMESSAGE, queued, nullptr, value->thread);
  if (value->queued) ++value->hooksInstalled;
  value->sent = value->queued ? SetWindowsHookExW(WH_CALLWNDPROC, sent, nullptr, value->thread) : nullptr;
  if (value->sent) ++value->hooksInstalled;
  if (!value->queued || !value->sent) { stop(value); return false; }
  return true;
}
static void release(Watch* watch) {
  if (watch->released) return;
  watch->released = true;
  if (watch->callback) { napi_delete_reference(watch->env, watch->callback); watch->callback = nullptr; }
  bool empty = true;
  for (unsigned i = 0; i < capacity; ++i) {
    if (watch->owner->watches[i] == watch) watch->owner->watches[i] = nullptr;
    if (watch->owner->watches[i]) empty = false;
  }
  if (empty) stop(watch->owner);
  drop(watch);
}
static void finalizer(napi_env, void* value, void*) {
  auto* watch = static_cast<Watch*>(value);
  release(watch); drop(watch);
}
static void functionFinalizer(napi_env, void* value, void*) { drop(static_cast<Watch*>(value)); }
static void cleanup(void* value) {
  auto* state = static_cast<Owner*>(value);
  state->closed = true;
  for (unsigned i = 0; i < capacity; ++i) if (state->watches[i]) release(state->watches[i]);
  stop(state);
  state->env = nullptr;
}
static napi_value healthy(napi_env env, napi_callback_info info) {
  void* value = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &value) != napi_ok) return nullptr;
  auto* watch = static_cast<Watch*>(value);
  napi_value result;
  if (napi_get_boolean(env, watch && watch->env == env && current(watch), &result) != napi_ok) return nullptr;
  return result;
}
static napi_value close(napi_env env, napi_callback_info info) {
  void* value = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &value) != napi_ok) return nullptr;
  auto* watch = static_cast<Watch*>(value);
  if (watch && watch->env == env && uiThread(watch->owner)) release(watch);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}
static napi_value observe(napi_env env, napi_callback_info info) {
  napi_value args[2], result, function;
  size_t count = 2, size = 0;
  void* bytes = nullptr;
  napi_valuetype callbackType;
  if (!runtime(env) || napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2 ||
    napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || size != sizeof(HWND) ||
    napi_typeof(env, args[1], &callbackType) != napi_ok || callbackType != napi_function) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_RUNTIME"); return nullptr;
  }
  if (owner.initialized && (owner.closed || owner.env != env || !sameThread(&owner) || owner.callbackDepth)) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_OWNER"); return nullptr;
  }
  unsigned slot = 0;
  while (slot < capacity && owner.watches[slot]) ++slot;
  if (slot == capacity) { napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CAPACITY"); return nullptr; }
  if (!owner.initialized) {
    owner.initialized = true; owner.env = env; owner.thread = GetCurrentThreadId(); owner.process = GetCurrentProcessId();
    if (napi_add_env_cleanup_hook(env, cleanup, &owner) != napi_ok) {
      owner.closed = true; napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_OWNER"); return nullptr;
    }
  }
  // Hold the original manager/context objects through every external COM call
  // and result construction. A nested last-release defers stop until this gate
  // exits and cannot reset the owner under a live GetFocus/Enum/GetWnd stack.
  Callback lifetime(&owner);
  if (!lifetime.entered) { napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_OWNER"); return nullptr; }
  auto* watch = static_cast<Watch*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(Watch)));
  if (!watch) { napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CAPACITY"); return nullptr; }
  watch->owner = &owner; watch->env = env; watch->refs = 1;
  // Do not assume caller Buffer alignment.
  auto* target = reinterpret_cast<unsigned char*>(&watch->root);
  for (size_t i = 0; i < sizeof(HWND); ++i) target[i] = static_cast<unsigned char*>(bytes)[i];
  if (!windowsCurrent(watch, true) || !start(&owner) || !windowsCurrent(watch) || !contextsCurrent(watch) || owner.invalid ||
    napi_create_reference(env, args[1], 1, &watch->callback) != napi_ok || owner.stopPending || owner.closed || owner.invalid) {
    if (watch->callback) napi_delete_reference(env, watch->callback);
    watch->released = true; drop(watch);
    bool empty = true; for (Watch* item : owner.watches) if (item) empty = false;
    if (empty) stop(&owner);
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
  }
  owner.watches[slot] = watch;
  if (napi_create_object(env, &result) != napi_ok) {
    release(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
  }
  retain(watch);
  if (napi_add_finalizer(env, result, watch, finalizer, nullptr, nullptr) != napi_ok) {
    drop(watch); release(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
  }
  const napi_callback callbacks[] = { healthy, close };
  const char* names[] = { "healthy", "release" };
  for (unsigned i = 0; i < 2; ++i) {
    if (napi_create_function(env, names[i], NAPI_AUTO_LENGTH, callbacks[i], watch, &function) != napi_ok) {
      release(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
    }
    retain(watch);
    if (napi_add_finalizer(env, function, watch, functionFinalizer, nullptr, nullptr) != napi_ok) {
      drop(watch); release(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
    }
    if (napi_set_named_property(env, result, names[i], function) != napi_ok) {
      release(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
    }
  }
  if (napi_object_freeze(env, result) != napi_ok) {
    release(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNQUALIFIED"); return nullptr;
  }
  return result;
}
// Read-only lifecycle accounting for the reviewed publisher/qualifier. These
// counts contain no window handle, text, key, lease credential or permission.
static napi_value accounting(napi_env env, napi_callback_info) {
  if (!runtime(env) || (owner.initialized && (owner.env != env || !uiThread(&owner)))) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_OWNER"); return nullptr;
  }
  unsigned leases = 0;
  unsigned contextRegistrations = 0;
  for (Watch* watch : owner.watches) if (watch) ++leases;
  for (unsigned i = 0; i < owner.contextsCount; ++i) if (owner.contexts[i].advised) ++contextRegistrations;
  // Snapshot before allocating any JS object/finalizer may run. Accounting is
  // evidence at this instant, never a current/execution authority for a leaf.
  struct Count { const char* name; unsigned value; };
  const ULONG sinkReferences = references(&owner.sink);
  const Count counts[] = {
    {"leases", leases}, {"hooksInstalled", owner.hooksInstalled}, {"hooksRemoved", owner.hooksRemoved},
    {"hooksOwned", static_cast<unsigned>(!!owner.queued) + static_cast<unsigned>(!!owner.sent)},
    {"advises", owner.advises}, {"unadvises", owner.unadvises},
    {"registrationsOwned", contextRegistrations + static_cast<unsigned>(owner.threadAdvised)},
    {"cleanupFailures", owner.cleanupFailures}, {"callbacks", owner.callbacks}, {"callbackDepth", owner.callbackDepth},
    {"retainedSinkRefs", sinkReferences > 1 ? sinkReferences - 1 : 0},
  };
  struct Flag { const char* name; bool value; };
  const Flag flags[] = {
    {"initialized", owner.initialized}, {"closed", owner.closed},
    {"invalid", owner.invalid || InterlockedCompareExchange(&owner.foreignCallback, 0, 0) != 0},
    {"stopPending", owner.stopPending}, {"unknownRegistration", owner.unknownRegistration},
  };
  napi_value result, value;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  for (const Count& item : counts) {
    if (napi_create_uint32(env, item.value, &value) != napi_ok ||
      napi_set_named_property(env, result, item.name, value) != napi_ok) return nullptr;
  }
  for (const Flag& item : flags) {
    if (napi_get_boolean(env, item.value, &value) != napi_ok ||
      napi_set_named_property(env, result, item.name, value) != napi_ok) return nullptr;
  }
  if (napi_object_freeze(env, result) != napi_ok) return nullptr;
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function, version;
  if (napi_create_function(env, "observe", NAPI_AUTO_LENGTH, observe, nullptr, &function) != napi_ok ||
    napi_set_named_property(env, exports, "observe", function) != napi_ok ||
    napi_create_function(env, "accounting", NAPI_AUTO_LENGTH, accounting, nullptr, &function) != napi_ok ||
    napi_set_named_property(env, exports, "accounting", function) != napi_ok ||
    napi_create_uint32(env, 1, &version) != napi_ok || napi_set_named_property(env, exports, "version", version) != napi_ok ||
    napi_object_freeze(env, exports) != napi_ok) return nullptr;
  return exports;
}
