#include <node_api.h>
#include <dlfcn.h>
#include <link.h>
#include <pthread.h>
#include <unistd.h>
#include <algorithm>
#include <cstring>
#include <memory>
#include <vector>
#include "linux-bridge.h"

#if !defined(DAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION) || !defined(DAC_MANAGED_BROWSER_INPUT_NODE_VERSION)
#error The fixed publisher must provide the reviewed managed browser input runtime cohort
#endif

// No GTK/XI2 connection or caller pointer fallback. Only the original patched
// runtime owns window/client identity and synchronous native/IME dispatch.
struct Owner;
struct Watch : std::enable_shared_from_this<Watch> {
  std::weak_ptr<Owner> owner;
  napi_env env;
  napi_ref callback = nullptr;
  uint64_t token = 0;
  bool closed = false;
};
struct Owner {
  napi_env env;
  pthread_t thread;
  pid_t process;
  const DacManagedInputBridgeV1* bridge;
  bool closed = false;
  std::vector<std::shared_ptr<Watch>> watches;
};
static bool thread(const std::shared_ptr<Owner>& owner) {
  return owner && !owner->closed && owner->process == getpid() && pthread_equal(owner->thread, pthread_self());
}
static void releaseWatch(const std::shared_ptr<Watch>& watch) {
  if (watch->closed) return;
  watch->closed = true;
  if (auto owner = watch->owner.lock()) {
    if (owner->bridge && watch->token) owner->bridge->release(watch->token, watch.get());
    if (watch->callback) napi_delete_reference(watch->env, watch->callback);
    watch->callback = nullptr;
    watch->token = 0;
    owner->watches.erase(std::remove(owner->watches.begin(), owner->watches.end(), watch), owner->watches.end());
  }
}
static int invalidate(void* data) {
  const auto watch = static_cast<Watch*>(data)->shared_from_this();
  const auto owner = watch->owner.lock();
  if (!thread(owner) || watch->closed || !watch->callback) return 0;
  napi_handle_scope scope;
  if (napi_open_handle_scope(watch->env, &scope) != napi_ok) return 0;
  napi_value callback, global, result;
  napi_status status = napi_get_reference_value(watch->env, watch->callback, &callback);
  if (status == napi_ok) status = napi_get_global(watch->env, &global);
  if (status == napi_ok) status = napi_call_function(watch->env, global, callback, 0, nullptr, &result);
  bool promise = false;
  const bool accepted = status == napi_ok && napi_is_promise(watch->env, result, &promise) == napi_ok && !promise;
  if (status != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(watch->env, &pending) == napi_ok && pending) {
      napi_value ignored;
      napi_get_and_clear_last_exception(watch->env, &ignored);
    }
  }
  if (!accepted) releaseWatch(watch);
  napi_close_handle_scope(watch->env, scope);
  return accepted;
}
static std::shared_ptr<Watch> receiver(napi_env env, napi_callback_info info) {
  napi_value self;
  void* data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr) != napi_ok ||
      napi_unwrap(env, self, &data) != napi_ok || !data) return {};
  return *static_cast<std::shared_ptr<Watch>*>(data);
}
static napi_value healthy(napi_env env, napi_callback_info info) {
  const auto watch = receiver(env, info);
  const auto owner = watch ? watch->owner.lock() : nullptr;
  const bool value = watch && thread(owner) && !watch->closed && watch->token &&
    owner->bridge->healthy(watch->token, watch.get());
  if (watch && !value && thread(owner)) releaseWatch(watch);
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}
static napi_value release(napi_env env, napi_callback_info info) {
  const auto watch = receiver(env, info);
  if (watch) {
    const auto owner = watch->owner.lock();
    if (owner && !owner->closed && !thread(owner)) {
      napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_THREAD");
      return nullptr;
    }
    releaseWatch(watch);
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value observe(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value arguments[2];
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, arguments, nullptr, &data) != napi_ok || count != 2 || !data) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_WINDOW"); return nullptr;
  }
  const auto owner = *static_cast<std::shared_ptr<Owner>*>(data);
  bool buffer = false;
  void* bytes = nullptr;
  size_t size = 0;
  napi_valuetype type;
  if (!thread(owner) || napi_is_buffer(env, arguments[0], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, arguments[0], &bytes, &size) != napi_ok || (size != 4 && size != 8) ||
      napi_typeof(env, arguments[1], &type) != napi_ok || type != napi_function) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_WINDOW"); return nullptr;
  }
  uint64_t window = 0;
  std::memcpy(&window, bytes, size);
  if (!window || window > UINT32_MAX || owner->watches.size() >= 16) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CAPACITY"); return nullptr;
  }
  const auto watch = std::make_shared<Watch>();
  watch->env = env;
  watch->owner = owner;
  if (napi_create_reference(env, arguments[1], 1, &watch->callback) != napi_ok) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CALLBACK"); return nullptr;
  }
  const int status = owner->bridge->observe(window, invalidate, watch.get(), &watch->token);
  if (status != 0 || !watch->token) {
    releaseWatch(watch);
    napi_throw_error(env, nullptr, status == 2 ? "MANAGED_BROWSER_INPUT_CAPACITY" : "MANAGED_BROWSER_INPUT_WINDOW");
    return nullptr;
  }
  napi_value lease;
  napi_create_object(env, &lease);
  const auto wrapped = new std::shared_ptr<Watch>(watch);
  if (napi_wrap(env, lease, wrapped, [](napi_env, void* data, void*) {
    const auto held = static_cast<std::shared_ptr<Watch>*>(data);
    releaseWatch(*held);
    delete held;
  }, nullptr, nullptr) != napi_ok) {
    delete wrapped;
    releaseWatch(watch);
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_LEASE"); return nullptr;
  }
  napi_property_descriptor properties[] = {
    {"healthy", nullptr, healthy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, lease, 2, properties);
  napi_object_freeze(env, lease);
  owner->watches.push_back(watch);
  return lease;
}
static napi_value accounting(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  const auto owner = *static_cast<std::shared_ptr<Owner>*>(data);
  uint32_t active = 0, callbacks = 0;
  if (thread(owner)) for (const auto& watch : owner->watches) if (!watch->closed) ++active;
  // Counters are read-only diagnostics, never a qualification/source authority.
  if (thread(owner) && !owner->watches.empty()) {
    uint32_t ignored = 0;
    owner->bridge->accounting(owner->watches.front().get(), &ignored, &callbacks);
  }
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_uint32(env, active, &value);
  napi_set_named_property(env, result, "active", value);
  napi_create_uint32(env, callbacks, &value);
  napi_set_named_property(env, result, "callbacks", value);
  napi_object_freeze(env, result);
  return result;
}
static bool property(napi_env env, napi_value object, const char* key, const char* expected) {
  napi_value value;
  char text[128];
  size_t size = 0;
  return napi_get_named_property(env, object, key, &value) == napi_ok &&
    napi_get_value_string_utf8(env, value, text, sizeof(text), &size) == napi_ok &&
    size == std::strlen(expected) && std::strcmp(text, expected) == 0;
}
static void* mainImage() {
  void* base = nullptr;
  dl_iterate_phdr([](dl_phdr_info* image, size_t, void* data) {
    if (image->dlpi_name && !image->dlpi_name[0]) {
      *static_cast<void**>(data) = reinterpret_cast<void*>(image->dlpi_addr);
      return 1;
    }
    return 0;
  }, &base);
  return base;
}
static bool originalImage(const void* address, const void* base) {
  Dl_info info{};
  return base && address && dladdr(address, &info) && info.dli_fbase == base;
}
NAPI_MODULE_INIT() {
  napi_value global, process, versions;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_get_named_property(env, global, "process", &process) != napi_ok ||
      !property(env, process, "platform", "linux") || !property(env, process, "arch", "x64") ||
      !property(env, process, "type", "browser") ||
      napi_get_named_property(env, process, "versions", &versions) != napi_ok ||
      !property(env, versions, "electron", DAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION) ||
      !property(env, versions, "node", DAC_MANAGED_BROWSER_INPUT_NODE_VERSION)) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_RUNTIME_ABI"); return nullptr;
  }
  const auto factory = reinterpret_cast<DacManagedInputBridgeFactoryV1>(dlsym(RTLD_DEFAULT, DAC_MANAGED_INPUT_BRIDGE_SYMBOL));
  const void* base = mainImage();
  const auto api = factory && originalImage(reinterpret_cast<void*>(factory), base) ? factory() : nullptr;
  if (!api || !originalImage(api, base) || api->version != 1 || api->struct_size != sizeof(*api) ||
      !originalImage(api->runtime_build_id, base) || std::strcmp(api->runtime_build_id, DAC_MANAGED_INPUT_RUNTIME_ID) ||
      !originalImage(reinterpret_cast<void*>(api->observe), base) ||
      !originalImage(reinterpret_cast<void*>(api->healthy), base) ||
      !originalImage(reinterpret_cast<void*>(api->release), base) ||
      !originalImage(reinterpret_cast<void*>(api->release_owner), base) ||
      !originalImage(reinterpret_cast<void*>(api->accounting), base)) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_RUNTIME_BRIDGE"); return nullptr;
  }
  const auto owner = new std::shared_ptr<Owner>(std::make_shared<Owner>());
  (*owner)->env = env;
  (*owner)->thread = pthread_self();
  (*owner)->process = getpid();
  (*owner)->bridge = api;
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_property_descriptor properties[] = {
    {"version", nullptr, nullptr, nullptr, nullptr, version, napi_default, nullptr},
    {"observe", nullptr, observe, nullptr, nullptr, nullptr, napi_default, owner},
    {"accounting", nullptr, accounting, nullptr, nullptr, nullptr, napi_default, owner},
  };
  napi_define_properties(env, exports, 3, properties);
  napi_object_freeze(env, exports);
  napi_add_env_cleanup_hook(env, [](void* data) {
    const auto owner = static_cast<std::shared_ptr<Owner>*>(data);
    (*owner)->closed = true;
    const auto watches = (*owner)->watches;
    for (const auto& watch : watches) releaseWatch(watch);
    delete owner;
  }, owner);
  return exports;
}
