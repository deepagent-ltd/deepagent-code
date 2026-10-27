#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cstring>
#include <fstream>
#include <string>

// Private fixture only: delegate the actual AppKit APIs and count lifecycle calls.
static unsigned installed = 0;
static unsigned removed = 0;
static std::string cleanupPath;
static IMP originalAdd;
static IMP originalRemove;
static NSMutableArray<NSWindow *> *windows;
static NSMutableSet<NSValue *> *monitors;
static bool tracking = false;
static std::string tracePath;
static bool trackedMask(NSEventMask mask) {
#if defined(DAC_QA_SOURCE_MASK_ONLY) && DAC_QA_SOURCE_MASK_ONLY
  // Main integration can keep tracking enabled while Electron installs unrelated monitors.
  // Match the frozen production mask exactly; this flag changes only the QA counter.
  const NSEventMask sourceMask = NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged |
    NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskRightMouseDown |
    NSEventMaskRightMouseUp | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp |
    NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged | NSEventMaskRightMouseDragged |
    NSEventMaskOtherMouseDragged | NSEventMaskScrollWheel | NSEventMaskGesture |
    NSEventMaskMagnify | NSEventMaskSwipe | NSEventMaskRotate |
    NSEventMaskMouseEntered | NSEventMaskMouseExited | NSEventMaskCursorUpdate;
  return mask == sourceMask;
#else
  (void)mask;
  return true;
#endif
}
static id countedAdd(id self, SEL command, NSEventMask mask, id block) {
  NSEvent *(^handler)(NSEvent *) = block;
  if (!tracePath.empty() && trackedMask(mask)) {
    NSEvent *(^delegate)(NSEvent *) = handler;
    handler = ^NSEvent *(NSEvent *event) {
      // Diagnostic categories only. The original source monitor receives the
      // exact event, and remains the sole authority for invalidation.
      std::ofstream file(tracePath, std::ios::app);
      file << "{\"at\":" << (long long)(NSDate.date.timeIntervalSince1970 * 1000)
        << ",\"type\":" << (unsigned long long)event.type << "}\n";
      return delegate(event);
    };
  }
  id monitor = ((id (*)(id, SEL, NSEventMask, id))originalAdd)(self, command, mask, handler);
  if (monitor && tracking && trackedMask(mask)) {
    installed++;
    [monitors addObject:[NSValue valueWithPointer:(__bridge void *)monitor]];
  }
  return monitor;
}
static void countedRemove(id self, SEL command, id monitor) {
  NSValue *identity = [NSValue valueWithPointer:(__bridge void *)monitor];
  if ([monitors containsObject:identity]) { removed++; [monitors removeObject:identity]; }
  ((void (*)(id, SEL, id))originalRemove)(self, command, monitor);
}
static NSWindow *windowFor(napi_env env, napi_value value) {
  bool buffer = false;
  void *bytes = nullptr;
  size_t size = 0;
  if (napi_is_buffer(env, value, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, value, &bytes, &size) != napi_ok || size != sizeof(void *)) return nil;
  void *pointer = nullptr;
  std::memcpy(&pointer, bytes, size);
  if (!pointer) return nil;
  for (NSWindow *window in NSApp.windows) if (window.contentView && (__bridge void *)window.contentView == pointer) return window;
  return nil;
}
static napi_value postKey(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  NSWindow *window = count == 1 ? windowFor(env, argument) : nil;
  if (!window || !NSThread.isMainThread) { napi_throw_error(env, nullptr, "QA_WINDOW"); return nullptr; }
  NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0
    timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
    characters:@"q" charactersIgnoringModifiers:@"q" isARepeat:NO keyCode:12];
  [NSApp postEvent:event atStart:NO];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value counts(napi_env env, napi_callback_info) {
  napi_value result, add, remove;
  napi_create_object(env, &result);
  napi_create_uint32(env, installed, &add);
  napi_create_uint32(env, removed, &remove);
  napi_set_named_property(env, result, "installed", add);
  napi_set_named_property(env, result, "removed", remove);
  return result;
}
static napi_value makeWindow(napi_env env, napi_callback_info) {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
    styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed = NO;
  [windows addObject:window];
  void *pointer = (__bridge void *)window.contentView;
  napi_value result;
  napi_create_buffer_copy(env, sizeof(pointer), &pointer, nullptr, &result);
  return result;
}
static napi_value closeWindows(napi_env env, napi_callback_info) {
  for (NSWindow *window in windows) [window close];
  [windows removeAllObjects];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value cleanup(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0;
  napi_value argument;
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  char value[4096];
  if (count != 1 || napi_get_value_string_utf8(env, argument, value, sizeof(value), &length) != napi_ok || length == 0)
    return nullptr;
  cleanupPath.assign(value, length);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value track(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  if (count != 1 || napi_get_value_bool(env, argument, &tracking) != napi_ok) return nullptr;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value trace(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0;
  napi_value argument;
  char value[4096];
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  if (count != 1 || napi_get_value_string_utf8(env, argument, value, sizeof(value), &length) != napi_ok ||
      !length || length >= sizeof(value)) { napi_throw_error(env, nullptr, "QA_TRACE_PATH"); return nullptr; }
  tracePath.assign(value, length);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  windows = [NSMutableArray new];
  monitors = [NSMutableSet new];
  Method add = class_getClassMethod(NSEvent.class, @selector(addLocalMonitorForEventsMatchingMask:handler:));
  Method remove = class_getClassMethod(NSEvent.class, @selector(removeMonitor:));
  originalAdd = method_setImplementation(add, (IMP)countedAdd);
  originalRemove = method_setImplementation(remove, (IMP)countedRemove);
  napi_property_descriptor properties[] = {
    {"postKey", nullptr, postKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"counts", nullptr, counts, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cleanup", nullptr, cleanup, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"makeWindow", nullptr, makeWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeWindows", nullptr, closeWindows, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"tracking", nullptr, track, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"trace", nullptr, trace, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 7, properties);
  napi_add_env_cleanup_hook(env, [](void *) {
    if (cleanupPath.empty()) return;
    std::ofstream file(cleanupPath);
    file << "{\"installed\":" << installed << ",\"removed\":" << removed << "}";
  }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
