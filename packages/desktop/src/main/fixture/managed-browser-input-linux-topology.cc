#include <node_api.h>
#include <X11/Xlib.h>
#include <X11/extensions/XRes.h>
#include <dlfcn.h>
#include <unistd.h>
#include <stdint.h>
#include <string.h>

// QA only. Read symbols already loaded by stock Electron; loading GTK here
// would make the backend test circular. Never expose a production input lease,
// context pointer, key or composition text.
namespace {
using Type = unsigned long;
using Boolean = int;
using Hook = unsigned long;
using Emission = Boolean (*)(void*, unsigned, const void*, void*);
struct Signal { const char* name; unsigned id; Hook hook; uint32_t count; };
Signal signals[] = {{"commit", 0, 0, 0}, {"preedit-start", 0, 0, 0},
  {"preedit-changed", 0, 0, 0}, {"preedit-end", 0, 0, 0}, {"delete-surrounding", 0, 0, 0}};
void* gtk = nullptr;
void* object = nullptr;
void* gdk = nullptr;
void* klass = nullptr;
void* display = nullptr;
Display* xdisplay = nullptr;
using Remove = void (*)(unsigned, Hook);
using Unref = void (*)(void*);
Remove removeHook = nullptr;
Unref unrefClass = nullptr;

Boolean emitted(void*, unsigned, const void*, void* data) {
  auto* signal = static_cast<Signal*>(data);
  if (signal->count < UINT32_MAX) ++signal->count;
  return 1;
}
void cleanup(void*) {
  for (auto& signal : signals) {
    if (signal.hook && removeHook) removeHook(signal.id, signal.hook);
    signal.hook = 0;
  }
  if (klass && unrefClass) unrefClass(klass);
  klass = nullptr;
  if (gdk) dlclose(gdk);
  if (object) dlclose(object);
  if (gtk) dlclose(gtk);
  gdk = object = gtk = nullptr;
}
void boolean(napi_env env, napi_value target, const char* name, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  napi_set_named_property(env, target, name, result);
}
void number(napi_env env, napi_value target, const char* name, uint32_t value) {
  napi_value result;
  napi_create_uint32(env, value, &result);
  napi_set_named_property(env, target, name, result);
}
Window handle(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  void* data = nullptr;
  size_t bytes = 0;
  bool buffer = false;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_is_buffer(env, argument, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, argument, &data, &bytes) != napi_ok || (bytes != 4 && bytes != 8)) return 0;
  uint64_t xid = 0;
  memcpy(&xid, data, bytes);
  return xid > 0 && xid <= UINT32_MAX ? static_cast<Window>(xid) : 0;
}
bool owned(Window window) {
  if (!window || !xdisplay) return false;
  XResClientIdSpec spec{window, XRES_CLIENT_ID_PID_MASK};
  long count = 0;
  XResClientIdValue* values = nullptr;
  if (XResQueryClientIds(xdisplay, 1, &spec, &count, &values) != Success) return false;
  bool result = false;
  for (long index = 0; index < count; ++index) {
    if (XResGetClientIdType(&values[index]) == XRES_CLIENT_ID_PID &&
        XResGetClientPid(&values[index]) == getpid()) result = true;
  }
  XResClientIdsDestroy(count, values);
  return result;
}
napi_value inspect(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  const Window window = handle(env, info);
  boolean(env, result, "gtk3AlreadyLoaded", gtk != nullptr);
  boolean(env, result, "gdkX11Display", xdisplay != nullptr);
  boolean(env, result, "xresSameProcessWindow", owned(window));
  const auto lookup = gdk ? reinterpret_cast<void* (*)(void*, Window)>(dlsym(gdk, "gdk_x11_window_lookup_for_display")) : nullptr;
  boolean(env, result, "existingGdkClientWindow", window && lookup && display && lookup(display, window));
  // Emission hooks give a context, not its Chromium TextInputClient authority.
  boolean(env, result, "publicContextWindowGetter", gtk && dlsym(gtk, "gtk_im_context_get_client_window"));
  boolean(env, result, "originalContextWindowJoin", false);
  boolean(env, result, "chromiumPredispatchObserver", false);
  boolean(env, result, "runtimeQualified", false);
  for (const auto& signal : signals) number(env, result, signal.name, signal.count);
  uint32_t hooks = 0;
  for (const auto& signal : signals) hooks += signal.hook != 0;
  number(env, result, "installedSignalHooks", hooks);
  return result;
}
}
NAPI_MODULE_INIT() {
  gtk = dlopen("libgtk-3.so.0", RTLD_NOW | RTLD_NOLOAD);
  gdk = dlopen("libgdk-3.so.0", RTLD_NOW | RTLD_NOLOAD);
  object = dlopen("libgobject-2.0.so.0", RTLD_NOW | RTLD_NOLOAD);
  if (gtk && gdk && object) {
    const auto getDisplay = reinterpret_cast<void* (*)()>(dlsym(gdk, "gdk_display_get_default"));
    const auto displayType = reinterpret_cast<Type (*)()>(dlsym(gdk, "gdk_x11_display_get_type"));
    const auto isType = reinterpret_cast<Boolean (*)(void*, Type)>(dlsym(object, "g_type_check_instance_is_a"));
    const auto getXDisplay = reinterpret_cast<Display* (*)(void*)>(dlsym(gdk, "gdk_x11_display_get_xdisplay"));
    const auto contextType = reinterpret_cast<Type (*)()>(dlsym(gtk, "gtk_im_context_get_type"));
    const auto refClass = reinterpret_cast<void* (*)(Type)>(dlsym(object, "g_type_class_ref"));
    const auto lookup = reinterpret_cast<unsigned (*)(const char*, Type)>(dlsym(object, "g_signal_lookup"));
    const auto addHook = reinterpret_cast<Hook (*)(unsigned, unsigned, Emission, void*, void*)>(dlsym(object, "g_signal_add_emission_hook"));
    removeHook = reinterpret_cast<Remove>(dlsym(object, "g_signal_remove_emission_hook"));
    unrefClass = reinterpret_cast<Unref>(dlsym(object, "g_type_class_unref"));
    if (getDisplay) display = getDisplay();
    if (display && displayType && isType && getXDisplay && isType(display, displayType())) xdisplay = getXDisplay(display);
    if (contextType && refClass && lookup && addHook && removeHook && unrefClass) {
      const Type type = contextType();
      klass = refClass(type);
      for (auto& signal : signals) {
        signal.id = lookup(signal.name, type);
        if (signal.id) signal.hook = addHook(signal.id, 0, emitted, &signal, nullptr);
      }
    }
  }
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_value method;
  napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, inspect, nullptr, &method);
  napi_set_named_property(env, exports, "inspect", method);
  return exports;
}
