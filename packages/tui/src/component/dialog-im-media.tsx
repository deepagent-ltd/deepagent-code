import { Show, onMount, onCleanup, createMemo, createEffect } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { Schema } from "effect"
import { useTuiPaths } from "../context/runtime"
import { useTuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { DialogIMForm, type IMFormField } from "./dialog-im-form"
import { createMediaIntentStore, createMediaBatchStore } from "../util/im-media-intent"
import { readMediaFile, publishMediaStream } from "./im-media"
import { createMediaPreview } from "./im-media-preview"
import type { IMClient, IMGroup, IMMessage, IMRemoteAttachmentRef } from "./im-client"

type Form = { title: string; fields: IMFormField[]; submit: (values: string[], active: () => boolean) => Promise<void> }

export function DialogIMMedia(props: {
  client: IMClient
  group: IMGroup
  identity?: string
  remote?: IMRemoteAttachmentRef
  remoteAttachments?: readonly IMRemoteAttachmentRef[]
  attachmentID?: string
  attachments?: readonly { id: string; name: string; messageID?: string }[]
  back: () => void
  onSent: (message: IMMessage) => void
}) {
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const paths = useTuiPaths()
  const abort = new AbortController()
  const store = createMediaIntentStore(paths.state)
  const batchStore = createMediaBatchStore(paths.state)
  let uploadAbort: AbortController | undefined
  const [state, setState] = createStore({
    enabled: false,
    busy: true,
    failed: false,
    records: [] as MediaIntent.Record[],
    batches: [] as MediaBatch.Record[],
    policy: undefined as MediaBatch.Policy | undefined,
    caption: "",
    cancelled: false,
    menuGeneration: 0,
    candidates: [] as Awaited<ReturnType<typeof readMediaFile>>[],
    uploadProgress: "",
    attachment: undefined as MediaIntent.Attachment | undefined,
    remote: undefined as IMRemoteAttachmentRef | undefined,
    form: undefined as Form | undefined,
    preview: undefined as Awaited<ReturnType<typeof createMediaPreview>> | undefined,
    saved: false,
  })
  const owner = {
    client: props.client,
    scope: props.client.scope(),
    groupID: props.group.id,
    workspaceID: props.group.workspaceID,
    identity: props.identity,
  }
  let disposed = false
  const scope = () =>
    MediaIntent.scope({
      server: props.client.scope().url,
      directory: props.client.scope().directory ?? "",
      workspaceID: props.group.workspaceID,
      groupID: props.group.id,
      memberID: props.identity ?? "",
    })
  const active = () => {
    if (disposed || abort.signal.aborted) return false
    if (
      props.client !== owner.client ||
      props.client.scope() !== owner.scope ||
      props.group.id !== owner.groupID ||
      props.group.workspaceID !== owner.workspaceID ||
      props.identity !== owner.identity
    ) {
      abort.abort()
      state.preview?.close()
      return false
    }
    return true
  }
  createEffect(() => {
    if (!active()) setState({ attachment: undefined, remote: undefined, candidates: [], enabled: false })
  })
  createEffect(() => {
    const expiry = state.remote?.attachment.expiresAt ?? state.attachment?.expiresAt
    if (!expiry) return
    const timer = setTimeout(
      () => {
        state.preview?.close()
        setState({ attachment: undefined, remote: undefined, preview: undefined, form: undefined, failed: true })
      },
      Math.max(0, expiry - Date.now()),
    )
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => {
    disposed = true
    abort.abort()
    uploadAbort?.abort()
    state.preview?.close()
    setState("candidates", [])
  })
  const draft = () => state.batches.find((batch) => batch.phase === "draft")
  const reload = async () => {
    const [records, batches] = await Promise.all([store.list(scope()), batchStore.list(scope())])
    if (!active()) return
    const claimed = new Set(
      batches
        .filter((batch) => batch.phase !== "unavailable")
        .flatMap((batch) => batch.files.map((file) => file.intentID)),
    )
    setState({
      records: records.filter(
        (item) => item.phase !== "bound" && item.phase !== "unavailable" && !claimed.has(item.id),
      ),
      batches: batches.filter((batch) => !["bound", "unavailable"].includes(batch.phase)),
    })
  }
  onMount(() => {
    void (async () => {
      // Receiving uses the authenticated locator authority, independently of upload policy.
      if (props.remote) {
        if (props.remote.groupID !== owner.groupID) throw new Error("media_scope_mismatch")
        const ref = { ...props.remote, attachment: { ...props.remote.attachment } }
        await props.client.getRemoteAttachment(ref, abort.signal)
        if (!active()) return
        setState("remote", ref)
      }
      if (props.attachmentID) {
        const value = await props.client.getAttachment(props.attachmentID, abort.signal)
        const original = props.attachments?.find((item) => item.id === props.attachmentID)
        if (
          value.groupID !== props.group.id ||
          value.workspaceID !== props.group.workspaceID ||
          !value.messageID ||
          (original?.messageID !== undefined && value.messageID !== original.messageID)
        )
          throw new Error("media_scope_mismatch")
        if (!active()) return
        setState("attachment", value)
      }
      if (
        !props.identity ||
        !(await props.client.mediaEnabled(abort.signal))
      )
        return
      if (!active()) return
      const status = await props.client.facadeStatus(abort.signal)
      if (!active()) return
      if (props.group.kernelConvID || props.group.reader) {
        const detail = await props.client.getGroup(props.group.id, abort.signal)
        if (!active()) return
        // Pending history is distinct from the server's current send authority.
        if (detail.group.id !== owner.groupID || detail.group.workspaceID !== owner.workspaceID ||
            (detail.group.reader?.state !== "pending" && detail.group.reader?.state !== "ready") ||
            !status.viewer?.memberID || status.reader?.state !== "ready" || status.kernel !== "connected" ||
            !detail.reader || detail.reader.displayEpoch !== status.reader.displayEpoch) return
      }
      if (Schema.is(MediaBatch.Policy)(status.media)) setState("policy", status.media)
      setState("enabled", !state.policy || state.policy.enabled)
      await reload()
      if (active()) setState("caption", draft()?.content ?? "")
    })()
      .catch(() => {
        if (active()) setState("failed", true)
      })
      .finally(() => {
        if (active()) setState("busy", false)
      })
  })
  const run = async (operation: () => Promise<void>, receiving = false) => {
    if (state.busy || (!receiving && !state.enabled) || !active()) return
    setState({ busy: true, failed: false, saved: false })
    try {
      await operation()
    } catch {
      if (active()) setState("failed", true)
    } finally {
      if (active()) {
        await reload().catch(() => {
          if (active()) setState("failed", true)
        })
        if (active()) setState({ busy: false, menuGeneration: state.menuGeneration + 1 })
      }
    }
  }
  const send = async (record: MediaIntent.Record) => {
    if (
      !active() ||
      !record.attachment ||
      record.attachment.expiresAt <= Date.now() ||
      !(await props.client.mediaEnabled(abort.signal)) ||
      !active()
    )
      throw new Error("media_unavailable")
    // A process may die with 'sending' persisted. Explicit retry reconciles that same ID.
    const previous =
      record.phase === "sending"
        ? await store.put(MediaIntent.change(record, "send_outcome_unknown"), record.revision)
        : record
    if (!active()) throw new Error("media_scope_changed")
    const sending = await store.put(MediaIntent.change(previous, "sending"), previous.revision)
    try {
      if (!active()) throw new Error("media_scope_changed")
      const value = await props.client.createMessage(
        props.group.id,
        {
          type: "file",
          content: sending.attachment!.filename,
          attachmentID: sending.attachment!.id,
          clientRequestID: sending.requestID,
        },
        abort.signal,
      )
      if (
        value.groupID !== props.group.id ||
        value.senderID !== props.identity ||
        value.type !== "file" ||
        value.metadata?.type !== "attachment_ref" ||
        value.metadata.attachmentID !== sending.attachment!.id
      )
        throw new Error("media_receipt_mismatch")
      await store.put(
        MediaIntent.change(sending, "bound", { ...sending.attachment, messageID: value.id }),
        sending.revision,
      )
      if (active()) {
        setState("records", (values) => values.filter((value) => value.id !== sending.id))
        props.onSent(value)
      }
    } catch (error) {
      await store.put(MediaIntent.change(sending, "send_outcome_unknown"), sending.revision).catch(() => undefined)
      throw error
    }
  }
  const upload = () =>
    run(async () => {
      const candidates = [...state.candidates]
      if (
        !candidates.length ||
        candidates.length + (draft()?.files.length ?? 0) > 4 ||
        !(await props.client.mediaEnabled(abort.signal)) ||
        !active()
      )
        throw new Error("media_disabled")
      const controller = new AbortController()
      uploadAbort = controller
      const signal = AbortSignal.any([abort.signal, controller.signal])
      setState({ candidates: [], cancelled: false })
      try {
        for (const [index, candidate] of candidates.entries()) {
          signal.throwIfAborted()
          if (!active()) return
          setState(
            "uploadProgress",
            i18n.t("tui.im.media.batch.uploadProgress", { current: index + 1, total: candidates.length }),
          )
          const prepared = await store.put(MediaIntent.create(scope(), candidate.file))
          const uploading = await store.put(MediaIntent.change(prepared, "uploading"), prepared.revision)
          const received = await props.client
            .uploadAttachment(
              new File([candidate.bytes], candidate.file.name, { type: candidate.file.mime }),
              props.group.id,
              signal,
            )
            .then(
              (receipt) => store.put(MediaIntent.change(uploading, "uploaded_unbound", receipt), uploading.revision),
              async (error: unknown) => {
                await store
                  .put(MediaIntent.change(uploading, "upload_outcome_unknown"), uploading.revision)
                  .catch(() => undefined)
                throw error
              },
            )
          if (!active() || signal.aborted) return
          const previous = (await batchStore.list(scope())).find((batch) => batch.phase === "draft")
          await batchStore.put(
            previous
              ? MediaBatch.edit(previous, { files: [...previous.files, MediaBatch.item(received)] })
              : MediaBatch.create(scope(), MediaBatch.item(received), state.policy?.enabled ? "batch" : "legacy"),
            previous?.revision,
          )
          await reload()
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        if (uploadAbort === controller) uploadAbort = undefined
        if (active()) setState("uploadProgress", "")
      }
    })
  const sendBatch = async (record: MediaBatch.Record) => {
    if (!active() || !MediaIntent.sameScope(record.scope, scope()) || !(await props.client.mediaEnabled(abort.signal)))
      throw new Error("media_unavailable")
    const status = await props.client.facadeStatus(abort.signal)
    if (!active()) throw new Error("media_scope_changed")
    if (Schema.is(MediaBatch.Policy)(status.media) && !status.media.enabled) throw new Error("media_disabled")
    const policy = Schema.is(MediaBatch.Policy)(status.media) && status.media.enabled ? status.media : undefined
    if (
      !policy &&
      ((record.format === "batch" && record.phase !== "draft") ||
        record.files.length !== 1 ||
        (state.caption !== "" && record.phase === "draft"))
    )
      throw new Error("media_batch_unsupported")
    const prepared =
      record.phase === "draft"
        ? await batchStore.put(
            MediaBatch.edit(record, {
              content: policy ? state.caption : record.files[0].attachment.filename,
              format: policy ? "batch" : "legacy",
            }),
            record.revision,
          )
        : record.phase === "sending"
          ? await batchStore.put(MediaBatch.change(record, "send_outcome_unknown"), record.revision)
          : record
    const sending = await batchStore.put(MediaBatch.change(prepared, "sending"), prepared.revision)
    await reload()
    try {
      if (!active()) throw new Error("media_scope_changed")
      const message = await props.client.createMessage(
        sending.scope.groupID,
        {
          type: "file",
          content: sending.content,
          clientRequestID: sending.requestID,
          ...(sending.format === "batch"
            ? { attachmentIDs: sending.files.map((file) => file.attachment.id) }
            : { attachmentID: sending.files[0].attachment.id }),
        },
        abort.signal,
      )
      if (!MediaBatch.matches(sending, message)) throw new Error("media_receipt_mismatch")
      await batchStore.put(MediaBatch.change(sending, "bound", message.id), sending.revision)
      await (async () => {
        const records = await store.list(sending.scope)
        for (const file of sending.files) {
          const original = records.find((item) => item.id === file.intentID)
          if (original?.phase === "uploaded_unbound")
            await store.put(
              MediaIntent.change(original, "bound", { ...file.attachment, messageID: message.id }),
              original.revision,
            )
        }
      })().catch(() => undefined)
      if (active()) {
        if (record.phase === "draft") setState("caption", "")
        props.onSent(message)
      }
    } catch (error) {
      await batchStore.put(MediaBatch.change(sending, "send_outcome_unknown"), sending.revision).catch(() => undefined)
      throw error
    }
  }
  const removeDraft = async (record: MediaBatch.Record, intentID: string) => {
    if (record.phase !== "draft" || !active()) return
    const original = (await store.list(record.scope)).find((item) => item.id === intentID)
    if (!original || original.phase !== "uploaded_unbound") throw new Error("media_store_conflict")
    await store.put(MediaIntent.change(original, "unavailable"), original.revision)
    const files = record.files.filter((file) => file.intentID !== intentID)
    await batchStore.put(
      files.length ? MediaBatch.edit(record, { files }) : MediaBatch.change(record, "unavailable"),
      record.revision,
    )
  }
  const select = (action: string) => {
    if (action === "cancelUpload" && uploadAbort) {
      uploadAbort.abort()
      return
    }
    if (state.busy) return
    if (action === "back") {
      props.back()
      return
    }
    if (!state.enabled && action !== "download" && action !== "preview" &&
      !action.startsWith("remote:") && !action.startsWith("details:")) return
    if (action === "choose") {
      setState("form", {
        title: i18n.t("tui.im.media.upload"),
        fields: [{ label: i18n.t("tui.im.media.localPath") }],
        submit: async (values, current) => {
          const candidate = await readMediaFile(values[0], abort.signal)
          if (active() && current()) {
            if (state.candidates.length + (draft()?.files.length ?? 0) >= 4) throw new Error("media_batch_limit")
            setState("candidates", (values) => [...values, candidate])
            setState("form", undefined)
          }
        },
      })
      return
    }
    if (action === "upload") {
      void upload()
      return
    }
    if (action === "sendBatch" && draft()) {
      void run(() => sendBatch(structuredClone(unwrap(draft()!))))
      return
    }
    if (action === "caption") {
      setState("form", {
        title: i18n.t("tui.im.media.batch.note"),
        fields: [{ label: i18n.t("tui.im.media.batch.note"), value: state.caption }],
        submit: async (values, current) => {
          const record = draft() && structuredClone(unwrap(draft()!))
          if (!record || !active() || !current()) return
          await batchStore.put(MediaBatch.edit(record, { content: values[0] }), record.revision)
          if (active() && current()) {
            setState({ caption: values[0], form: undefined })
            await reload()
          }
        },
      })
      return
    }
    if (action.startsWith("batchRetry:")) {
      const record = state.batches.find((batch) => action === `batchRetry:${batch.id}`)
      if (record) void run(() => sendBatch(structuredClone(unwrap(record))))
      return
    }
    if (action.startsWith("draftRemove:")) {
      const record = draft()
      const item = record?.files.find((file) => action === `draftRemove:${file.intentID}`)
      if (record && item) void run(() => removeDraft(structuredClone(unwrap(record)), item.intentID))
      return
    }
    if (action === "cancelCandidate") {
      setState("candidates", [])
      return
    }
    if (action.startsWith("removeCandidate:")) {
      const index = Number(action.slice(16))
      setState("candidates", (values) => values.filter((_, at) => at !== index))
      return
    }
    if (action === "download" && (state.attachment || state.remote)) {
      const remote = state.remote ? { ...state.remote, attachment: { ...state.remote.attachment } } : undefined
      const value = remote
        ? {
            sizeBytes: remote.attachment.sizeBytes,
            checksum: remote.attachment.sha256,
            expiresAt: remote.attachment.expiresAt,
          }
        : MediaIntent.attachment(state.attachment)
      setState("form", {
        title: i18n.t("tui.im.media.download"),
        fields: [{ label: i18n.t("tui.im.media.savePath") }],
        submit: async (values, current) => {
          if (!active()) return
          const source = remote
            ? await props.client.streamRemoteAttachment(remote, abort.signal)
            : await props.client.streamAttachment(MediaIntent.attachment(value), abort.signal)
          await publishMediaStream(values[0], source, abort.signal, () => active() && current())
          if (active() && current()) {
            setState("saved", true)
            setState("form", undefined)
          }
        },
      })
      return
    }
    if (action === "preview" && (state.attachment || state.remote)) {
      void run(async () => {
        state.preview?.close()
        const preview = await createMediaPreview({
          ...(state.remote
            ? { remote: { ...state.remote, attachment: { ...state.remote.attachment } } }
            : { attachment: MediaIntent.attachment(state.attachment) }),
          client: props.client,
          signal: abort.signal,
        })
        if (!active()) {
          preview.close()
          return
        }
        setState("preview", preview)
      }, true)
      return
    }
    if (action.startsWith("remote:")) {
      const selected = props.remoteAttachments?.find(
        (ref) => `remote:${ref.messageID}:${ref.attachment.attachmentID}` === action,
      )
      if (!selected || selected.groupID !== owner.groupID) return
      const ref = { ...selected, attachment: { ...selected.attachment } }
      void run(async () => {
        await props.client.getRemoteAttachment(ref, abort.signal)
        if (active()) {
          state.preview?.close()
          setState({ attachment: undefined, remote: ref, preview: undefined })
        }
      }, true)
      return
    }
    if (action.startsWith("details:")) {
      const id = action.slice(8)
      const original = props.attachments?.find((item) => item.id === id)
      if (!original) return
      void run(async () => {
        const value = await props.client.getAttachment(id, abort.signal)
        if (
          value.groupID !== props.group.id ||
          value.workspaceID !== props.group.workspaceID ||
          !value.messageID ||
          (original.messageID !== undefined && value.messageID !== original.messageID)
        )
          throw new Error("media_scope_mismatch")
        if (active()) {
          state.preview?.close()
          setState({ attachment: value, remote: undefined, preview: undefined })
        }
      }, true)
      return
    }
    const record = state.records.find((item) => action.endsWith(`:${item.id}`))
    if (!record) return
    if (action.startsWith("retry:")) void run(() => send(structuredClone(unwrap(record))))
    if (action.startsWith("discard:")) void run(() => store.discard(structuredClone(unwrap(record))))
  }
  const displayed = () => state.remote?.attachment ?? state.attachment
  const options = createMemo(() =>
    [
      ...(state.enabled && state.candidates.length + (draft()?.files.length ?? 0) < 4
        ? [
            {
              value: "choose",
              title: i18n.t(state.candidates.length ? "tui.im.media.batch.add" : "tui.im.media.upload"),
            },
          ]
        : []),
      ...(state.candidates.length
        ? [
            ...state.candidates.map((candidate, index) => ({
              value: `removeCandidate:${index}`,
              title: `${i18n.t("tui.im.media.batch.remove")} · ${AttachmentPreview.displayName(candidate.file.name)} · ${candidate.file.sizeBytes} B`,
            })),
            {
              value: "upload",
              title: `${i18n.t("tui.im.media.batch.upload")} · ${state.candidates.length}`,
            },
            { value: "cancelCandidate", title: i18n.t("tui.im.media.discard") },
          ]
        : []),
      ...(draft()
        ? [
            ...draft()!.files.map((file) => ({
              value: `draftRemove:${file.intentID}`,
              title: `${i18n.t("tui.im.media.batch.remove")} · ${AttachmentPreview.displayName(file.attachment.filename)}`,
            })),
            ...(state.policy?.enabled ? [{ value: "caption", title: i18n.t("tui.im.media.batch.note") }] : []),
            ...(state.policy?.enabled || (draft()!.files.length === 1 && state.caption === "")
              ? [{ value: "sendBatch", title: `${i18n.t("tui.im.media.batch.send")} · ${draft()!.files.length}` }]
              : []),
          ]
        : []),
      ...state.batches
        .filter((batch) => batch.phase !== "draft")
        .map((batch) => ({
          value: `batchRetry:${batch.id}`,
          title: `${i18n.t("tui.im.media.retry")} · ${batch.files.length}`,
        })),
      ...(uploadAbort ? [{ value: "cancelUpload", title: i18n.t("tui.im.media.batch.cancelUpload") }] : []),
      ...(displayed()
        ? [
            { value: "download", title: i18n.t("tui.im.media.download") },
            ...(["image/png", "image/jpeg"].includes(displayed()!.mime) &&
            displayed()!.sizeBytes <= AttachmentPreview.previewBytes
              ? [{ value: "preview", title: i18n.t("tui.im.media.preview") }]
              : []),
          ]
        : []),
      ...(props.attachments ?? []).slice(-50).map((item) => ({
        value: `details:${item.id}`,
        title: `${i18n.t("tui.im.media.details")} · ${AttachmentPreview.displayName(item.name)}`,
      })),
      ...(props.remoteAttachments ?? []).slice(-200).map((ref) => ({
        value: `remote:${ref.messageID}:${ref.attachment.attachmentID}`,
        title: `${i18n.t("tui.im.media.details")} · ${AttachmentPreview.displayName(ref.attachment.filename)}`,
      })),
      ...state.records.flatMap((record) => [
        ...(["uploaded_unbound", "sending", "send_outcome_unknown"].includes(record.phase)
          ? [
              {
                value: `retry:${record.id}`,
                title: `${i18n.t("tui.im.media.retry")} · ${AttachmentPreview.displayName(record.file.name)}`,
              },
            ]
          : []),
        {
          value: `discard:${record.id}`,
          title: `${i18n.t(`tui.im.media.phase.${MediaIntent.observedPhase(record)}`)} · ${AttachmentPreview.displayName(record.file.name)} · ${i18n.t("tui.im.media.discard")}`,
        },
      ]),
      { value: "back", title: i18n.t("tui.im.media.back") },
    ].filter((option) => !state.busy || option.value === "cancelUpload"),
  )
  // Keep one mounted dialog owner while its menu switches to a form.
  return (
    <box>
      <Show
        when={state.form}
        fallback={
          <Show when={state.menuGeneration + 1} keyed>
            {(_generation) => (
              <DialogSelect
                title={i18n.t("tui.im.media.title")}
                options={options()}
                locked={state.busy && !uploadAbort}
                skipFilter={state.busy}
                onSelect={(option) => select(option.value)}
                titleView={
                  <box gap={1}>
                    <text fg={theme.text}>{i18n.t("tui.im.media.title")}</text>
                    <text fg={theme.textMuted} wrapMode="word">
                      {i18n.t("tui.im.media.batch.limits")}
                    </text>
                    <Show when={!props.group.kernelConvID}>
                      <text fg={theme.textMuted} wrapMode="word">
                        {i18n.t("tui.im.media.localOnly")}
                      </text>
                    </Show>
                    <Show when={state.busy}>
                      <text fg={theme.textMuted}>{i18n.t("tui.im.loading")}</text>
                    </Show>
                    <Show when={!state.busy && !state.enabled}>
                      <text fg={theme.textMuted}>{i18n.t("tui.im.media.disabled")}</text>
                    </Show>
                    <Show when={state.uploadProgress}>
                      <text fg={theme.textMuted}>{state.uploadProgress}</text>
                    </Show>
                    <Show when={draft() && !state.policy?.enabled && draft()!.files.length > 1}>
                      <text fg={theme.textMuted} wrapMode="word">
                        {i18n.t("tui.im.media.batch.multipleUnavailable")}
                      </text>
                    </Show>
                    <Show when={state.batches.some((batch) => batch.phase !== "draft")}>
                      <text fg={theme.textMuted} wrapMode="word">
                        {i18n.t(state.busy ? "tui.im.media.batch.sending" : "tui.im.media.batch.unknown")}
                      </text>
                    </Show>
                    <Show when={state.caption}>
                      <text fg={theme.textMuted} wrapMode="word">
                        {state.caption}
                      </text>
                    </Show>
                    <Show when={state.failed}>
                      <text fg={theme.error} wrapMode="word">
                        {i18n.t("tui.im.media.failed")}
                      </text>
                    </Show>
                    <Show when={state.saved}>
                      <text fg={theme.success}>{i18n.t("tui.im.media.saved")}</text>
                    </Show>
                    <Show when={displayed()}>
                      {(value) => (
                        <text fg={theme.textMuted} wrapMode="word">
                          {AttachmentPreview.displayName(value().filename)} · {value().mime} · {value().sizeBytes} B
                        </text>
                      )}
                    </Show>
                    <Show when={state.preview}>
                      {(value) => (
                        <text fg={theme.primary} wrapMode="word">
                          <a href={value().url}>{i18n.t("tui.im.media.link")}</a>
                        </text>
                      )}
                    </Show>
                  </box>
                }
              />
            )}
          </Show>
        }
      >
        {(form) => <DialogIMForm {...form()} back={() => setState("form", undefined)} />}
      </Show>
    </box>
  )
}
