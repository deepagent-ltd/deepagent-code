#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <dlfcn.h>
#include <memory>
#include <vector>

#if !defined(DAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION) || !defined(DAC_MANAGED_BROWSER_INPUT_NODE_VERSION)
#error The fixed publisher must provide the reviewed managed browser input runtime cohort
#endif

struct Owner;
struct HookSlot;
struct Client { __weak NSView *view; };
struct Watch : std::enable_shared_from_this<Watch> {
  std::weak_ptr<Owner> owner;
  napi_env env;
  napi_ref callback = nullptr;
  __weak NSWindow *window;
  __weak NSView *root;
  std::vector<Client> clients;
  HookSlot *hooks = nullptr;
  id monitor = nil;
  id closing = nil;
  bool invalid = false;
  bool closed = false;
  std::atomic<bool> diagnosed{false};
};
struct Owner {
  napi_env env;
  bool closed = false;
  std::vector<std::shared_ptr<Watch>> watches;
};
struct HookSlot {
  Class type;
  SEL selectors[4];
  Method methods[4];
  IMP original[4];
  IMP wrappers[4];
  std::vector<std::weak_ptr<Watch>> users;
  bool installed = false;
  std::atomic<bool> tainted{false};
};
// One exact, version-coupled Cocoa class. Original IMPs outlive Node environments:
// another native hook can retain our trampoline after it loses ownership.
static std::atomic<HookSlot *> slot{nullptr};
static void releaseWatch(const std::shared_ptr<Watch>& watch);
static void insertText(id, SEL, id, NSRange);
static void setMarkedText(id, SEL, id, NSRange, NSRange);
static void unmarkText(id, SEL);
static void viewDidMoveToWindow(id, SEL);

static bool directMethod(Class type, SEL selector, Method expected) {
  unsigned count = 0;
  Method *methods = class_copyMethodList(type, &count);
  bool found = false;
  for (unsigned i = 0; i < count; i++) if (method_getName(methods[i]) == selector && methods[i] == expected) found = true;
  std::free(methods);
  return found;
}
static bool methodABI(Method method, unsigned count) {
  if (!method || method_getNumberOfArguments(method) != count) return false;
  char *result = method_copyReturnType(method);
  const bool returnsVoid = result && std::strcmp(result, @encode(void)) == 0;
  std::free(result);
  if (!returnsVoid) return false;
  for (unsigned i = 0; i < count; i++) {
    char *argument = method_copyArgumentType(method, i);
    const char *expected = i == 0 || i == 2 ? @encode(id) : i == 1 ? @encode(SEL) : @encode(NSRange);
    const bool matches = argument && std::strcmp(argument, expected) == 0;
    std::free(argument);
    if (!matches) return false;
  }
  return true;
}
static bool hooksOwned(HookSlot *hooks) {
  if (!hooks || hooks->tainted.load() || !hooks->installed) return false;
  for (unsigned i = 0; i < 4; i++) if (
      class_getInstanceMethod(hooks->type, hooks->selectors[i]) != hooks->methods[i] ||
      !directMethod(hooks->type, hooks->selectors[i], hooks->methods[i]) ||
      method_getImplementation(hooks->methods[i]) != hooks->wrappers[i] ||
      !methodABI(hooks->methods[i], i == 0 ? 4 : i == 1 ? 5 : 2)) {
    hooks->tainted.store(true); return false;
  }
  return true;
}
static HookSlot *requireHooks() {
  if (HookSlot *existing = slot.load()) {
    if (existing->tainted.load()) return nullptr;
    if (existing->installed) return hooksOwned(existing) ? existing : nullptr;
    for (unsigned i = 0; i < 4; i++) if (
        class_getInstanceMethod(existing->type, existing->selectors[i]) != existing->methods[i] ||
        !directMethod(existing->type, existing->selectors[i], existing->methods[i]) ||
        !methodABI(existing->methods[i], i == 0 ? 4 : i == 1 ? 5 : 2) ||
        method_getImplementation(existing->methods[i]) != existing->original[i]) {
      existing->tainted.store(true); return nullptr;
    }
    return existing;
  }
  Class type = objc_getClass("RenderWidgetHostViewCocoa");
  if (!type) return nullptr;
  auto hooks = std::make_unique<HookSlot>();
  hooks->type = type;
  const SEL selectors[] = { @selector(insertText:replacementRange:),
    @selector(setMarkedText:selectedRange:replacementRange:), @selector(unmarkText), @selector(viewDidMoveToWindow) };
  const IMP wrappers[] = { (IMP)insertText, (IMP)setMarkedText, (IMP)unmarkText, (IMP)viewDidMoveToWindow };
  for (unsigned i = 0; i < 4; i++) {
    hooks->selectors[i] = selectors[i]; hooks->wrappers[i] = wrappers[i];
    hooks->methods[i] = class_getInstanceMethod(type, selectors[i]);
    if (!directMethod(type, selectors[i], hooks->methods[i]) ||
        !methodABI(hooks->methods[i], i == 0 ? 4 : i == 1 ? 5 : 2)) return nullptr;
    hooks->original[i] = method_getImplementation(hooks->methods[i]);
    if (!hooks->original[i] || hooks->original[i] == wrappers[i]) return nullptr;
    Dl_info image{};
    if (!dladdr((void *)hooks->original[i], &image) || !image.dli_fname) return nullptr;
    const char *name = std::strrchr(image.dli_fname, '/');
    if (std::strcmp(name ? name + 1 : image.dli_fname, "Electron Framework") != 0) return nullptr;
  }
  HookSlot *result = hooks.release(); slot.store(result); return result;
}
static bool collectClients(NSView *view, HookSlot *hooks, NSMutableArray<NSView *> *clients, unsigned depth, unsigned& nodes,
    const char **failure = nullptr) {
  if (!view || depth > 32 || ++nodes > 1024) {
    if (failure) *failure = !view ? "client_tree_missing" : depth > 32 ? "client_tree_depth" : "client_tree_nodes";
    return false;
  }
  if ([view isKindOfClass:hooks->type]) {
    // Subclasses can override these methods without entering our exact class.
    if (object_getClass(view) != hooks->type || clients.count >= 16) {
      if (failure) *failure = object_getClass(view) != hooks->type ? "client_class_changed" : "client_tree_capacity";
      return false;
    }
    [clients addObject:view];
  }
  for (NSView *child in view.subviews) if (!collectClients(child, hooks, clients, depth + 1, nodes, failure)) return false;
  return true;
}
static bool sourceRejected(const std::shared_ptr<Watch>& watch, const char *reason, long clients = -1) {
  const char *diagnostics = std::getenv("DAC_MANAGED_BROWSER_INPUT_DIAGNOSTICS");
  if (diagnostics && std::strcmp(diagnostics, "1") == 0 && !watch->diagnosed.exchange(true)) {
    // Fixed categories and bounded counts only; -1 means the tree was not collected.
    // Never emit a view address or input payload.
    static std::atomic<unsigned> reported{0};
    if (reported.fetch_add(1) < 128) std::fprintf(stderr,
      "MANAGED_BROWSER_INPUT_DIAGNOSTIC {\"at\":%lld,\"reason\":\"%s\",\"expectedClients\":%zu,\"actualClients\":%ld}\n",
      (long long)(NSDate.date.timeIntervalSince1970 * 1000), reason, watch->clients.size(), clients);
  }
  return false;
}
static bool currentWindow(const std::shared_ptr<Watch>& watch) {
  if (watch->closed) return sourceRejected(watch, "lease_closed");
  if (watch->invalid) return sourceRejected(watch, "lease_invalid");
  if (!NSThread.isMainThread) return sourceRejected(watch, "not_main_thread");
  if (!watch->window) return sourceRejected(watch, "window_released");
  if (!watch->root) return sourceRejected(watch, "root_released");
  if (!hooksOwned(watch->hooks)) return sourceRejected(watch, "hooks_unowned");
  bool owned = false;
  for (NSWindow *window in NSApp.windows) if (window == watch->window && window.contentView == watch->root) owned = true;
  if (!owned) return sourceRejected(watch, "window_root_changed");
  NSMutableArray<NSView *> *clients = [NSMutableArray new]; unsigned nodes = 0;
  const char *failure = nullptr;
  if (!collectClients(watch->root, watch->hooks, clients, 0, nodes, &failure)) return sourceRejected(watch, failure, clients.count);
  if (clients.count != watch->clients.size()) return sourceRejected(watch, "client_count_changed", clients.count);
  for (size_t i = 0; i < watch->clients.size(); i++) {
    if (!watch->clients[i].view) return sourceRejected(watch, "client_released", clients.count);
    if (clients[i] != watch->clients[i].view) return sourceRejected(watch, "client_identity_changed", clients.count);
    if (watch->clients[i].view.window != watch->window) return sourceRejected(watch, "client_window_changed", clients.count);
    if (object_getClass(watch->clients[i].view) != watch->hooks->type) return sourceRejected(watch, "client_class_changed", clients.count);
  }
  return true;
}
static void signalWatch(const std::shared_ptr<Watch>& watch) {
  if (watch->closed || !NSThread.isMainThread) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(watch->env, &scope) != napi_ok) { releaseWatch(watch); return; }
  napi_value callback, global, result;
  napi_status status = napi_get_reference_value(watch->env, watch->callback, &callback);
  if (status == napi_ok) status = napi_get_global(watch->env, &global);
  // Never inspect or copy the platform input arguments into the JS boundary.
  if (status == napi_ok) status = napi_call_function(watch->env, global, callback, 0, nullptr, &result);
  bool promise = false;
  if (status == napi_ok && napi_is_promise(watch->env, result, &promise) == napi_ok && promise) releaseWatch(watch);
  if (status != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(watch->env, &pending) == napi_ok && pending) {
      napi_value ignored; napi_get_and_clear_last_exception(watch->env, &ignored);
    }
    releaseWatch(watch);
  }
  napi_close_handle_scope(watch->env, scope);
}
static void platformSource(NSView *view, HookSlot *hooks, bool lifecycle) {
  if (!NSThread.isMainThread) { hooks->tainted.store(true); return; }
  const auto users = hooks->users;
  for (const auto& user : users) if (auto watch = user.lock()) {
    if (watch->closed) continue;
    const bool known = std::any_of(watch->clients.begin(), watch->clients.end(),
      [view](const auto& client) { return client.view == view; });
    if (!known && view.window != watch->window) continue;
    if (lifecycle || !known || !currentWindow(watch)) {
      if (lifecycle || !known) sourceRejected(watch, lifecycle ? "client_view_moved" : "client_unobserved");
      watch->invalid = true; signalWatch(watch); releaseWatch(watch); continue;
    }
    signalWatch(watch);
  }
}
static void insertText(id self, SEL selector, id text, NSRange replacement) {
  __strong NSView * __attribute__((objc_precise_lifetime)) held = self;
  HookSlot *hooks = slot.load(); IMP original = hooks->original[0];
  platformSource(held, hooks, false);
  ((void (*)(id, SEL, id, NSRange))original)(held, selector, text, replacement);
}
static void setMarkedText(id self, SEL selector, id text, NSRange selected, NSRange replacement) {
  __strong NSView * __attribute__((objc_precise_lifetime)) held = self;
  HookSlot *hooks = slot.load(); IMP original = hooks->original[1];
  platformSource(held, hooks, false);
  ((void (*)(id, SEL, id, NSRange, NSRange))original)(held, selector, text, selected, replacement);
}
static void unmarkText(id self, SEL selector) {
  __strong NSView * __attribute__((objc_precise_lifetime)) held = self;
  HookSlot *hooks = slot.load(); IMP original = hooks->original[2];
  platformSource(held, hooks, false); ((void (*)(id, SEL))original)(held, selector);
}
static void viewDidMoveToWindow(id self, SEL selector) {
  __strong NSView * __attribute__((objc_precise_lifetime)) held = self;
  HookSlot *hooks = slot.load(); IMP original = hooks->original[3];
  platformSource(held, hooks, true); ((void (*)(id, SEL))original)(held, selector);
}
static void releaseWatch(const std::shared_ptr<Watch>& watch) {
  if (watch->closed) return;
  watch->closed = true;
  if (watch->monitor) [NSEvent removeMonitor:watch->monitor]; watch->monitor = nil;
  if (watch->closing) [NSNotificationCenter.defaultCenter removeObserver:watch->closing]; watch->closing = nil;
  if (watch->callback) napi_delete_reference(watch->env, watch->callback); watch->callback = nullptr;
  if (HookSlot *hooks = watch->hooks) {
    hooks->users.erase(std::remove_if(hooks->users.begin(), hooks->users.end(), [watch](const auto& user) {
      auto current = user.lock(); return !current || current == watch || current->closed;
    }), hooks->users.end());
    if (hooks->installed && hooks->users.empty()) {
      for (unsigned i = 0; i < 4; i++) {
        if (method_getImplementation(hooks->methods[i]) == hooks->wrappers[i])
          method_setImplementation(hooks->methods[i], hooks->original[i]);
        else hooks->tainted.store(true);
      }
      hooks->installed = false;
    }
  }
  if (auto owner = watch->owner.lock()) owner->watches.erase(
    std::remove(owner->watches.begin(), owner->watches.end(), watch), owner->watches.end());
}
static NSWindow *requireWindow(napi_env env, napi_value handle) {
  bool buffer = false; void *bytes = nullptr; size_t size = 0;
  if (napi_is_buffer(env, handle, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, handle, &bytes, &size) != napi_ok || size != sizeof(void *)) return nil;
  void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) return nil;
  // The supplied address is only compared against current AppKit-owned views.
  for (NSWindow *window in NSApp.windows) if (window.contentView && (__bridge void *)window.contentView == pointer) return window;
  return nil;
}
static std::shared_ptr<Watch> receiver(napi_env env, napi_callback_info info) {
  napi_value self; void *data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr) != napi_ok ||
      napi_unwrap(env, self, &data) != napi_ok || !data) return {};
  return *static_cast<std::shared_ptr<Watch> *>(data);
}
static napi_value healthy(napi_env env, napi_callback_info info) {
  auto watch = receiver(env, info); const bool value = watch && currentWindow(watch);
  if (watch && !value && NSThread.isMainThread) releaseWatch(watch);
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
static napi_value release(napi_env env, napi_callback_info info) {
  if (!NSThread.isMainThread) { napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_THREAD"); return nullptr; }
  if (auto watch = receiver(env, info)) releaseWatch(watch);
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value observe(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value arguments[2]; void *data = nullptr;
  napi_get_cb_info(env, info, &count, arguments, nullptr, &data);
  auto owner = *static_cast<std::shared_ptr<Owner> *>(data);
  if (count != 2 || !NSThread.isMainThread || owner->closed || !NSApp) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_UNAVAILABLE"); return nullptr;
  }
  NSWindow *window = requireWindow(env, arguments[0]); napi_valuetype type;
  if (!window || napi_typeof(env, arguments[1], &type) != napi_ok || type != napi_function) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_WINDOW"); return nullptr;
  }
  if (owner->watches.size() >= 16 || std::any_of(owner->watches.begin(), owner->watches.end(),
      [window](const auto& watch) { return watch->window == window; })) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CAPACITY"); return nullptr;
  }
  HookSlot *hooks = requireHooks(); NSMutableArray<NSView *> *clients = [NSMutableArray new]; unsigned nodes = 0;
  if (!hooks || !collectClients(window.contentView, hooks, clients, 0, nodes) || !clients.count) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CLIENT_ABI"); return nullptr;
  }
  auto watch = std::make_shared<Watch>(); watch->owner = owner; watch->env = env;
  watch->window = window; watch->root = window.contentView; watch->hooks = hooks;
  for (NSView *client in clients) watch->clients.push_back({ client });
  if (napi_create_reference(env, arguments[1], 1, &watch->callback) != napi_ok) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_CALLBACK"); return nullptr;
  }
  hooks->users.push_back(watch);
  if (!hooks->installed) {
    hooks->installed = true;
    for (unsigned i = 0; i < 4; i++) if (method_setImplementation(hooks->methods[i], hooks->wrappers[i]) != hooks->original[i])
      hooks->tainted.store(true);
  }
  if (!hooksOwned(hooks)) { releaseWatch(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_HOOK"); return nullptr; }
  Watch *pointer = watch.get();
  const NSEventMask mask = NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged |
    NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskRightMouseDown |
    NSEventMaskRightMouseUp | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp |
    NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged | NSEventMaskRightMouseDragged |
    NSEventMaskOtherMouseDragged | NSEventMaskScrollWheel | NSEventMaskGesture |
    NSEventMaskMagnify | NSEventMaskSwipe | NSEventMaskRotate |
    NSEventMaskMouseEntered | NSEventMaskMouseExited | NSEventMaskCursorUpdate;
  watch->monitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
    auto held = pointer->shared_from_this();
    if (!currentWindow(held)) { releaseWatch(held); return event; }
    if (event.window == held->window) signalWatch(held);
    return event;
  }];
  watch->closing = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification
    object:window queue:nil usingBlock:^(NSNotification *) {
      auto held = pointer->shared_from_this(); sourceRejected(held, "window_closing"); releaseWatch(held);
    }];
  if (!watch->monitor || !watch->closing) {
    releaseWatch(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_MONITOR"); return nullptr;
  }
  napi_value lease; napi_create_object(env, &lease); auto wrapped = new std::shared_ptr<Watch>(watch);
  if (napi_wrap(env, lease, wrapped, [](napi_env, void *data, void *) {
    auto held = static_cast<std::shared_ptr<Watch> *>(data); releaseWatch(*held); delete held;
  }, nullptr, nullptr) != napi_ok) {
    delete wrapped; releaseWatch(watch); napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_LEASE"); return nullptr;
  }
  napi_property_descriptor properties[] = {
    {"healthy", nullptr, healthy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, lease, 2, properties); napi_object_freeze(env, lease);
  owner->watches.push_back(watch); return lease;
}
static napi_value initialize(napi_env env, napi_value exports) {
  // This private Cocoa ABI and CDP separation were qualified against this exact
  // Electron build. A framework upgrade requires a fresh native source cohort.
  napi_value global, process, versions, electron, node, kind;
  char electronVersion[32], nodeVersion[32], runtimeType[32]; size_t versionLength = 0, nodeLength = 0, runtimeLength = 0;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_get_named_property(env, global, "process", &process) != napi_ok ||
      napi_get_named_property(env, process, "versions", &versions) != napi_ok ||
      napi_get_named_property(env, versions, "electron", &electron) != napi_ok ||
      napi_get_named_property(env, versions, "node", &node) != napi_ok ||
      napi_get_named_property(env, process, "type", &kind) != napi_ok ||
      napi_get_value_string_utf8(env, electron, electronVersion, sizeof(electronVersion), &versionLength) != napi_ok ||
      napi_get_value_string_utf8(env, node, nodeVersion, sizeof(nodeVersion), &nodeLength) != napi_ok ||
      napi_get_value_string_utf8(env, kind, runtimeType, sizeof(runtimeType), &runtimeLength) != napi_ok ||
      versionLength != std::strlen(DAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION) ||
      nodeLength != std::strlen(DAC_MANAGED_BROWSER_INPUT_NODE_VERSION) || runtimeLength != 7 ||
      std::strcmp(electronVersion, DAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION) != 0 ||
      std::strcmp(nodeVersion, DAC_MANAGED_BROWSER_INPUT_NODE_VERSION) != 0 || std::strcmp(runtimeType, "browser") != 0) {
    napi_throw_error(env, nullptr, "MANAGED_BROWSER_INPUT_RUNTIME_ABI"); return nullptr;
  }
  auto owner = new std::shared_ptr<Owner>(std::make_shared<Owner>()); (*owner)->env = env;
  napi_value version; napi_create_uint32(env, 1, &version);
  napi_property_descriptor properties[] = {
    {"version", nullptr, nullptr, nullptr, nullptr, version, napi_default, nullptr},
    {"observe", nullptr, observe, nullptr, nullptr, nullptr, napi_default, owner},
  };
  napi_define_properties(env, exports, 2, properties); napi_object_freeze(env, exports);
  napi_add_env_cleanup_hook(env, [](void *data) {
    auto held = static_cast<std::shared_ptr<Owner> *>(data); (*held)->closed = true;
    const auto watches = (*held)->watches;
    for (const auto& watch : watches) releaseWatch(watch); delete held;
  }, owner);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
