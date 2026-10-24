#ifndef DAC_MANAGED_BROWSER_INPUT_LINUX_BRIDGE_H_
#define DAC_MANAGED_BROWSER_INPUT_LINUX_BRIDGE_H_
#include <stddef.h>
#include <stdint.h>

// Private in-process ABI, never an HTTP/MCP capability or caller window pointer.
// The patched original runtime resolves a scalar handle through WindowList.
#define DAC_MANAGED_INPUT_RUNTIME_ID "dac-mbi-linux-x11-v1:electron41.10.6:chromium146.0.7680.216"
#define DAC_MANAGED_INPUT_BRIDGE_SYMBOL "dac_managed_input_observer_v1"
#ifdef __cplusplus
extern "C" {
#endif
// True only when the zero-argument JS invalidation completed synchronously.
typedef int (*DacManagedInputInvalidate)(void* owner);
struct DacManagedInputBridgeV1 {
  uint32_t version;
  uint32_t struct_size;
  const char* runtime_build_id;
  // status: 0 accepted, 1 invalid input, 2 capacity, 3 unsupported/unavailable.
  int (*observe)(uint64_t window, DacManagedInputInvalidate invalidate,
                 void* owner, uint64_t* token);
  int (*healthy)(uint64_t token, void* owner);
  void (*release)(uint64_t token, void* owner);
  void (*release_owner)(void* owner);
  void (*accounting)(void* owner, uint32_t* active, uint32_t* callbacks);
};
typedef const struct DacManagedInputBridgeV1* (*DacManagedInputBridgeFactoryV1)(void);
#ifdef __cplusplus
}
#endif
#endif
