// Copyright (c) 2026 DeepAgent Ltd. All rights reserved.
// Original DAC runtime component; upstream Electron/Chromium notices remain.
#include "shell/browser/dac_managed_input_bridge.h"

#include <array>
#include <cstdint>
#include <memory>
#include <string>

#include "content/public/browser/browser_thread.h"
#include "shell/browser/native_window.h"
#include "shell/browser/native_window_observer.h"
#include "shell/browser/window_list.h"
#include "ui/aura/window.h"
#include "ui/aura/window_observer.h"
#include "ui/aura/window_tree_host.h"
#include "ui/aura/window_tree_host_observer.h"
#include "ui/base/ime/input_method.h"
#include "ui/base/ime/input_method_observer.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/ozone/public/ozone_platform.h"

namespace {
class Watch;
std::array<std::shared_ptr<Watch>, 16> watches;
uint64_t next_token = 1;
uint32_t callbacks = 0;
bool ui_thread() {
  return content::BrowserThread::CurrentlyOn(content::BrowserThread::UI);
}
class Watch final : public std::enable_shared_from_this<Watch>,
                    public electron::NativeWindowObserver,
                    public aura::WindowObserver,
                    public aura::WindowTreeHostObserver,
                    public ui::InputMethodObserver {
 public:
  Watch(uint64_t token, uint64_t handle, electron::NativeWindow* native,
        DacManagedInputInvalidate invalidate, void* owner)
      : token_(token), handle_(handle), native_(native),
        window_(native->GetNativeWindow()), host_(window_->GetHost()),
        input_(host_->GetInputMethod()), client_(input_->GetTextInputClient()),
        invalidate_(invalidate), owner_(owner) {}
  void Attach() {
    native_->AddObserver(this);
    window_->AddObserver(this);
    host_->AddObserver(this);
    input_->AddObserver(this);
  }
  bool Healthy() const {
    if (!ui_thread() || retired_ || callback_depth_ ||
        !native_ || !window_ || !host_ || !input_) return false;
    return !native_->IsClosed() && native_->GetNativeWindow() == window_ &&
      window_->GetHost() == host_ && host_->GetInputMethod() == input_ &&
      static_cast<uint64_t>(native_->GetAcceleratedWidget()) == handle_ &&
      input_->GetTextInputClient() == client_ && input_->DacManagedInputBackend() &&
      std::string(input_->DacManagedInputBackend()) == "gtk3";
  }
  void Retire() {
    const auto keep_alive = shared_from_this();
    if (retired_) return;
    retired_ = true;
    if (input_) input_->RemoveObserver(this);
    if (host_) host_->RemoveObserver(this);
    if (window_) window_->RemoveObserver(this);
    if (native_) native_->RemoveObserver(this);
    input_ = nullptr;
    host_ = nullptr;
    window_ = nullptr;
    native_ = nullptr;
    for (auto& watch : watches) if (watch.get() == this) watch.reset();
  }
  void Invalidate() {
    const auto keep_alive = shared_from_this();
    if (!ui_thread() || retired_ || callback_depth_) { Retire(); return; }
    ++callback_depth_;
    if (callbacks != UINT32_MAX) ++callbacks;
    const int accepted = invalidate_(owner_);
    --callback_depth_;
    if (!accepted && !retired_) Retire();
  }
  void OnHostWillDispatchNativeInput(aura::WindowTreeHost* host,
                                    const ui::Event* event) override {
    if (host != host_ || !event || (event->flags() & ui::EF_FROM_DEBUGGER)) return;
    if (event->IsKeyEvent() || event->IsMouseEvent() || event->IsScrollEvent() ||
        event->IsTouchEvent() || event->IsGestureEvent()) Invalidate();
  }
  void OnBeforeFocusedTextInputClientChange(const ui::InputMethod* method,
      const ui::TextInputClient* before, const ui::TextInputClient* after) override {
    const auto keep_alive = shared_from_this();
    if (method != input_ || before != client_ || after != client_) {
      Invalidate();
      Retire();
      return;
    }
    Invalidate();
  }
  void OnBeforeNativeInputMethodMutation(const ui::InputMethod* method,
      const ui::TextInputClient* client) override {
    const auto keep_alive = shared_from_this();
    if (method != input_ || client != client_) {
      Invalidate();
      Retire();
      return;
    }
    Invalidate();
  }
  void OnTextInputStateChanged(const ui::TextInputClient* client) override {
    const auto keep_alive = shared_from_this();
    if (!input_ || client != client_ || input_->GetTextInputClient() != client_) {
      Invalidate();
      Retire();
      return;
    }
    Invalidate();
  }
  void OnInputMethodDestroyed(const ui::InputMethod* method) override {
    const auto keep_alive = shared_from_this();
    if (method != input_) return;
    // The original observer list is currently destructing; never access the
    // destroyed InputMethod again, including through a lazy GetInputMethod().
    input_ = nullptr;
    Invalidate();
    Retire();
  }
  void OnWindowDestroying(aura::Window* window) override {
    const auto keep_alive = shared_from_this();
    if (window != window_) return;
    Invalidate();
    Retire();
  }
  void OnWindowRemovingFromRootWindow(aura::Window* window,
                                      aura::Window*) override {
    const auto keep_alive = shared_from_this();
    if (window == window_) { Invalidate(); Retire(); }
  }
  void OnWindowClosed() override {
    const auto keep_alive = shared_from_this();
    Invalidate();
    Retire();
  }
  void OnWindowBlur() override { Invalidate(); }
  void OnWindowFocus() override { Invalidate(); }
  void OnWindowHide() override { Invalidate(); }
  void OnHostWillProcessBoundsChange(aura::WindowTreeHost*) override { Invalidate(); }
  void OnFocus() override { Invalidate(); }
  void OnBlur() override { Invalidate(); }
  void OnCaretBoundsChanged(const ui::TextInputClient*) override {}
  uint64_t token() const { return token_; }
  void* owner() const { return owner_; }
  uint64_t handle() const { return handle_; }
 private:
  uint64_t token_;
  uint64_t handle_;
  electron::NativeWindow* native_;
  aura::Window* window_;
  aura::WindowTreeHost* host_;
  ui::InputMethod* input_;
  const ui::TextInputClient* client_;
  DacManagedInputInvalidate invalidate_;
  void* owner_;
  uint32_t callback_depth_ = 0;
  bool retired_ = false;
};
std::shared_ptr<Watch> Find(uint64_t token, void* owner) {
  if (!ui_thread() || !token || !owner) return {};
  for (const auto& watch : watches)
    if (watch && watch->token() == token && watch->owner() == owner) return watch;
  return {};
}
int Observe(uint64_t handle, DacManagedInputInvalidate invalidate,
            void* owner, uint64_t* token) {
  if (!ui_thread() || !handle || handle > UINT32_MAX || !owner || !invalidate || !token) return 1;
  // This is the actual initialized runtime selection, not DISPLAY or argv.
  if (!ui::OzonePlatform::IsInitialized() ||
      ui::OzonePlatform::GetPlatformNameForTest() != "x11") return 3;
  for (const auto& watch : watches) if (watch && watch->handle() == handle) return 2;
  for (auto& slot : watches) {
    if (slot) continue;
    for (auto* native : electron::WindowList::GetWindows()) {
      if (!native || native->IsClosed() ||
          static_cast<uint64_t>(native->GetAcceleratedWidget()) != handle) continue;
      auto* window = native->GetNativeWindow();
      if (!window || !window->GetHost() || !window->GetHost()->GetInputMethod()) return 3;
      const char* backend = window->GetHost()->GetInputMethod()->DacManagedInputBackend();
      if (!backend || std::string(backend) != "gtk3") return 3;
      if (!next_token || next_token == UINT64_MAX) return 3;
      const auto watch = std::make_shared<Watch>(next_token++, handle, native, invalidate, owner);
      slot = watch;
      watch->Attach();
      if (!watch->Healthy()) { watch->Retire(); return 3; }
      *token = watch->token();
      return 0;
    }
    return 3;
  }
  return 2;
}
int Healthy(uint64_t token, void* owner) {
  const auto watch = Find(token, owner);
  return watch && watch->Healthy();
}
void Release(uint64_t token, void* owner) {
  const auto watch = Find(token, owner);
  if (watch) watch->Retire();
}
void ReleaseOwner(void* owner) {
  if (!ui_thread() || !owner) return;
  for (auto& slot : watches) {
    const auto watch = slot;
    if (watch && watch->owner() == owner) watch->Retire();
  }
}
void Accounting(void* owner, uint32_t* active, uint32_t* observed_callbacks) {
  if (!ui_thread() || !owner || !active || !observed_callbacks) return;
  *active = 0;
  for (const auto& watch : watches) if (watch && watch->owner() == owner) ++*active;
  *observed_callbacks = callbacks;
}
const DacManagedInputBridgeV1 api{1, sizeof(DacManagedInputBridgeV1),
  DAC_MANAGED_INPUT_RUNTIME_ID, Observe, Healthy, Release, ReleaseOwner, Accounting};
}
extern "C" __attribute__((visibility("default")))
const DacManagedInputBridgeV1* dac_managed_input_observer_v1() {
  return ui_thread() ? &api : nullptr;
}
