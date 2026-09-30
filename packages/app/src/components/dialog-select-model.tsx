import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useServerSync } from "@/context/server-sync"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@deepagent-code/ui/button"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tag } from "@deepagent-code/ui/tag"
import { Dialog } from "@deepagent-code/ui/dialog"
import { List } from "@deepagent-code/ui/list"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { Icon } from "@deepagent-code/ui/icon"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { showFreeModelTag } from "./model-tags"

type ModelState = ReturnType<typeof useLocal>["model"]

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={showFreeModelTag(item)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={showFreeModelTag(i)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

function ModelListActions(props: { onConnectProvider: () => void; onManage: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex items-center gap-1">
      <Tooltip placement="top" value={language.t("command.provider.connect")}>
        <IconButton
          icon="plus-small"
          variant="ghost"
          iconSize="normal"
          class="size-6"
          aria-label={language.t("command.provider.connect")}
          onClick={props.onConnectProvider}
        />
      </Tooltip>
      <Tooltip placement="top" value={language.t("dialog.model.manage")}>
        <IconButton
          icon="sliders"
          variant="ghost"
          iconSize="normal"
          class="size-6"
          aria-label={language.t("dialog.model.manage")}
          onClick={props.onManage}
        />
      </Tooltip>
    </div>
  )
}

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={<ModelListActions onConnectProvider={handleConnectProvider} onManage={handleManage} />}
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

export function ComposerModelSelector(props: { model: ModelState; style?: JSX.CSSProperties; onClose?: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const [store, setStore] = createStore<{
    open: boolean
    view: "effort" | "models"
    dismiss: Dismiss | null
  }>({ open: false, view: "effort", dismiss: null })
  const options = createMemo(() =>
    props.model.variant
      .list()
      .slice()
      .sort((a, b) => {
        const left = effortOrder.indexOf(a.toLowerCase())
        const right = effortOrder.indexOf(b.toLowerCase())
        if (left < 0 && right < 0) return 0
        if (left < 0) return 1
        if (right < 0) return -1
        return left - right
      }),
  )
  const selected = () => props.model.variant.current()
  const selectedIndex = createMemo(() => options().indexOf(selected() ?? ""))
  const fill = createMemo(() => {
    if (selectedIndex() < 0) return "0%"
    if (options().length === 1) return "100%"
    const progress = selectedIndex() / (options().length - 1)
    const offset = 14 - progress * 28
    return `calc(${progress * 100}% ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}px)`
  })
  const label = (value: string | undefined) => {
    if (!value) return language.t("common.default")
    if (value.toLowerCase() === "xhigh") return "XHigh"
    return value.charAt(0).toUpperCase() + value.slice(1)
  }
  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }
  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => dialog.show(() => <x.DialogManageModels />))
  }
  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-select-provider").then((x) => dialog.show(() => <x.DialogSelectProvider />))
  }

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(open) => {
        if (open) {
          setStore("dismiss", null)
          setStore("view", props.model.current() ? "effort" : "models")
          serverSync.refreshProviders()
        }
        setStore("open", open)
      }}
      modal={false}
      placement="top-end"
      gutter={8}
    >
      <Kobalte.Trigger
        as={Button}
        data-action="prompt-model"
        variant="ghost"
        size="normal"
        class="min-w-0 max-w-[260px] justify-start gap-1.5 rounded-full px-2.5 text-13-regular text-text-base"
        style={props.style}
      >
        <Show when={props.model.current()?.provider.id}>
          {(providerID) => <ProviderIcon id={providerID()} class="size-4 shrink-0" />}
        </Show>
        <span class="min-w-0 truncate">{props.model.current()?.name ?? language.t("dialog.model.select.title")}</span>
        <Show when={props.model.current()}>
          <span data-component="prompt-model-effort-label" class="shrink-0 text-text-weak">
            {label(selected())}
          </span>
        </Show>
        <Icon name="chevron-down" size="small" class="shrink-0" />
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          data-component="composer-model-popover"
          data-view={store.view}
          class="z-50 flex flex-col overflow-hidden outline-none"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (store.dismiss === "escape" || store.dismiss === "select") props.onClose?.()
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <Show
            when={store.view === "effort"}
            fallback={
              <>
                <div class="flex items-center gap-2 px-2 pb-2 text-13-medium text-text-strong">
                  <Show when={props.model.current()}>
                    <button
                      type="button"
                      class="flex size-7 items-center justify-center rounded-md text-text-base hover:bg-surface-base-hover"
                      onClick={() => setStore("view", "effort")}
                      aria-label={language.t("prompt.model.effort.back")}
                    >
                      <Icon name="chevron-left" size="small" />
                    </button>
                  </Show>
                  <span>{language.t("dialog.model.select.title")}</span>
                </div>
                <ModelList
                  model={props.model}
                  onSelect={() => close("select")}
                  class="p-1"
                  action={<ModelListActions onConnectProvider={handleConnectProvider} onManage={handleManage} />}
                />
              </>
            }
          >
            <div data-component="composer-effort-header" class="flex items-start justify-between gap-3">
              <Icon name="intelligence" class="mt-0.5 size-4 shrink-0 text-text-weak" />
              <div class="min-w-0 flex-1 text-center">
                <div data-component="composer-effort-title" class="text-16-medium">
                  {label(selected())}
                </div>
                <button
                  data-action="prompt-model-list"
                  type="button"
                  class="inline-flex max-w-full items-center gap-1 text-13-regular text-text-base hover:text-text-strong"
                  onClick={() => setStore("view", "models")}
                >
                  <span class="truncate">{props.model.current()?.name}</span>
                  <Icon name="chevron-right" size="small" class="shrink-0" />
                </button>
              </div>
              <button
                data-action="prompt-model-effort-reset"
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded-md text-text-weak hover:bg-surface-base-hover hover:text-text-strong disabled:opacity-40"
                disabled={!selected()}
                onClick={() => props.model.variant.set(undefined)}
                aria-label={language.t("prompt.model.effort.reset")}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="size-4">
                  <path
                    d="M16.5 9.5A6.5 6.5 0 1 1 14.7 5M16.5 3.5V8H12"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
            <Show
              when={options().length > 0}
              fallback={
                <div class="mt-5 text-center text-12-regular text-text-weak">
                  {language.t("prompt.model.effort.unavailable")}
                </div>
              }
            >
              <div
                data-component="composer-effort-track"
                data-count={options().length}
                role="group"
                aria-label={language.t("prompt.model.effort.label")}
              >
                <div data-component="composer-effort-fill" style={{ width: fill() }} aria-hidden="true" />
                <For each={options()}>
                  {(option, index) => (
                    <button
                      data-action="prompt-model-variant"
                      data-variant={option}
                      data-selected={selected() === option ? "true" : undefined}
                      data-before={index() < selectedIndex() ? "true" : undefined}
                      type="button"
                      onClick={() => props.model.variant.set(option)}
                      aria-label={label(option)}
                      aria-pressed={selected() === option}
                      title={label(option)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const provider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
