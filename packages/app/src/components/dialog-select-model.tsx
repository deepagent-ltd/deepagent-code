import { Popover as Kobalte } from "@kobalte/core/popover"
import fuzzysort from "fuzzysort"
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

function ComposerModelList(props: { model: ModelState; onSelect: () => void; action: JSX.Element }) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    query: "",
    expanded: props.model.current()?.provider.id,
    showAll: undefined as string | undefined,
  })
  const current = () => props.model.current()
  const groups = createMemo(() => {
    const query = store.query.trim().toLocaleLowerCase()
    const selected = current()
    const visible = props.model
      .list()
      .filter((model) => props.model.visible({ modelID: model.id, providerID: model.provider.id }))
    const models = query
      ? fuzzysort.go(query, visible, { keys: ["provider.name", "name", "id"] }).map((result) => result.obj)
      : visible
    const providers = new Map<string, { id: string; name: string; models: typeof models }>()
    models.forEach((model) => {
      const provider = providers.get(model.provider.id) ?? {
        id: model.provider.id,
        name: model.provider.name,
        models: [],
      }
      provider.models.push(model)
      providers.set(provider.id, provider)
    })
    return Array.from(providers.values())
      .map((provider) => ({
        ...provider,
        models: provider.models.sort((a, b) => {
          const aSelected = a.id === selected?.id && a.provider.id === selected.provider.id
          const bSelected = b.id === selected?.id && b.provider.id === selected.provider.id
          if (aSelected !== bSelected) return aSelected ? -1 : 1
          return a.name.localeCompare(b.name)
        }),
      }))
      .sort((a, b) => {
        if (a.id === selected?.provider.id) return -1
        if (b.id === selected?.provider.id) return 1
        const aRank = popularProviders.indexOf(a.id)
        const bRank = popularProviders.indexOf(b.id)
        if (aRank >= 0 && bRank < 0) return -1
        if (bRank >= 0 && aRank < 0) return 1
        if (aRank >= 0 && bRank >= 0) return aRank - bRank
        return a.name.localeCompare(b.name)
      })
  })

  return (
    <div data-component="composer-model-list" class="flex min-h-0 flex-1 flex-col">
      <div data-component="composer-model-search-row">
        <div data-component="composer-model-search">
          <Icon name="magnifying-glass" size="small" class="shrink-0" />
          <input
            type="search"
            autofocus
            value={store.query}
            placeholder={language.t("dialog.model.search.placeholder")}
            aria-label={language.t("dialog.model.search.placeholder")}
            onInput={(event) => {
              setStore("query", event.currentTarget.value)
              setStore("showAll", undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) {
                const first = groups()[0]?.models[0]
                if (!first) return
                event.preventDefault()
                props.model.set({ modelID: first.id, providerID: first.provider.id }, { recent: true })
                props.onSelect()
              }
              if (event.key !== "ArrowDown") return
              event.preventDefault()
              event.currentTarget
                .closest('[data-component="composer-model-popover"]')
                ?.querySelector<HTMLButtonElement>('[data-action="prompt-model-option"], [data-action="prompt-model-provider"]')
                ?.focus()
            }}
          />
        </div>
        {props.action}
      </div>
      <div data-component="composer-model-groups">
        <Show when={groups().length > 0} fallback={<div data-component="composer-model-empty">{language.t("dialog.model.empty")}</div>}>
          <For each={groups()}>
            {(provider) => {
              const expanded = () => !!store.query.trim() || store.expanded === provider.id
              const shown = () => (store.showAll === provider.id ? provider.models : provider.models.slice(0, 3))
              return (
                <section data-component="composer-model-provider" aria-label={provider.name}>
                  <Show
                    when={!store.query.trim()}
                    fallback={
                      <div data-component="composer-model-provider-header" data-expanded="true">
                        <span class="truncate">{provider.name}</span>
                      </div>
                    }
                  >
                    <button
                      data-action="prompt-model-provider"
                      data-component="composer-model-provider-header"
                      data-expanded={expanded()}
                      type="button"
                      aria-expanded={expanded()}
                      onClick={() => {
                        setStore("expanded", expanded() ? undefined : provider.id)
                        setStore("showAll", undefined)
                      }}
                    >
                      <span class="truncate">{provider.name}</span>
                      <Icon name="chevron-right" size="small" class="shrink-0" />
                    </button>
                  </Show>
                  <Show when={expanded()}>
                    <div data-component="composer-model-options">
                      <For each={shown()}>
                        {(model) => (
                          <Tooltip
                            class="w-full"
                            placement="right-start"
                            gutter={12}
                            value={<ModelTooltip model={model} latest={model.latest} free={showFreeModelTag(model)} />}
                          >
                            <button
                              data-action="prompt-model-option"
                              data-selected={model.id === current()?.id && model.provider.id === current()?.provider.id}
                              type="button"
                              aria-current={model.id === current()?.id && model.provider.id === current()?.provider.id ? "true" : undefined}
                              onClick={() => {
                                props.model.set({ modelID: model.id, providerID: model.provider.id }, { recent: true })
                                props.onSelect()
                              }}
                            >
                              <span class="min-w-0 flex-1 truncate text-left">{model.name}</span>
                              <Show when={showFreeModelTag(model)}>
                                <Tag>{language.t("model.tag.free")}</Tag>
                              </Show>
                              <Show when={model.latest}>
                                <Tag>{language.t("model.tag.latest")}</Tag>
                              </Show>
                              <Show when={model.id === current()?.id && model.provider.id === current()?.provider.id}>
                                <Icon name="check-small" size="small" class="shrink-0" />
                              </Show>
                            </button>
                          </Tooltip>
                        )}
                      </For>
                      <Show when={store.showAll !== provider.id && provider.models.length > 3}>
                        <button
                          data-action="prompt-model-more"
                          type="button"
                          aria-label={language.t("dialog.model.showMore", {
                            count: provider.models.length - 3,
                            provider: provider.name,
                          })}
                          title={language.t("dialog.model.showMore", {
                            count: provider.models.length - 3,
                            provider: provider.name,
                          })}
                          onClick={() => setStore("showAll", provider.id)}
                        >
                          ···
                        </button>
                      </Show>
                    </div>
                  </Show>
                </section>
              )
            }}
          </For>
        </Show>
      </div>
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
                <ComposerModelList
                  model={props.model}
                  onSelect={() => close("select")}
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
