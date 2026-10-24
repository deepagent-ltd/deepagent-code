import { app, BrowserWindow, session, dialog } from "electron"
import type { Session, WebContents } from "electron"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserPolicy } from "@deepagent-code/core/browser/shared-policy"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { SharedBrowserProtocol } from "@deepagent-code/core/browser/shared-protocol"
import { createManagedBrowserFiles } from "./managed-browser-files"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import type { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { SharedBrowserScriptPolicy } from "@deepagent-code/core/browser/shared-script-policy"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Schema } from "effect"
import { createSharedBrowserNetwork } from "./shared-browser-network"
import { createSharedBrowserDriver, createSharedBrowserWitnessBudget } from "./shared-browser-driver"
import { createSharedBrowserManualDownloads } from "./shared-browser-manual-download"
import { createSharedBrowserComputation } from "./shared-browser-compute"

type Driver = ReturnType<typeof createSharedBrowserDriver>
type Cleanup = { inputIsolated: boolean; heldReleased: boolean; transportStopped: boolean; unknownEffects: boolean }
type FileConfirmationOwner = { window: BrowserWindow; current: () => boolean }
type FileDecision = BrowserFileSchema.Confirmation | SharedBrowserFileSchema.Cancellation
type Tab = { tabID: string; generation: number; window: BrowserWindow; driver?: Driver; detachNetwork: () => void }
type Entry = {
  resource: SharedBrowserSchema.Resource
  descriptor: string
  policyPending?: { command: SharedBrowserSchema.ApproveOrigin; owner: string; current: () => boolean; claim?: string }
  policyOwners: Map<string, string>
  lease?: SharedBrowserSchema.Lease
  epoch: number
  partition: Session
  tabs: Map<string, Tab>
  witnessBudget: ReturnType<typeof createSharedBrowserWitnessBudget>
  selectedTabID?: string
  network?: Awaited<ReturnType<typeof createSharedBrowserNetwork>>
  action?: SharedBrowserSchema.Action
  context: AsyncLocalStorage<SharedBrowserSchema.Action>
  attaching: boolean
  dispatched: boolean
  queue: number
  chain: Promise<void>
  seen: Set<string>
  usedInputs: Set<string>
  unknownEffects: boolean
  confirmed: boolean
  cleanup: { inputIsolated: boolean; heldReleased: boolean; transportStopped: boolean }
  cleanupTask?: { epoch: number; promise: Promise<Cleanup>; settled: boolean }
  takeover?: {
    request: SharedBrowserSchema.Takeover
    ticket: SharedBrowserSchema.BarrierTicket
    completion: Promise<SharedBrowserSchema.Observation>
    committed: boolean
  }
  pendingClose?: SharedBrowserSchema.Close
  closePromise?: Promise<SharedBrowserSchema.Observation>
  closeTask?: { promise: Promise<SharedBrowserSchema.Observation>; settled: boolean }
  closeWaiting?: boolean
  preview?: { png: string; observedAt: number; manualEpoch: number }
  timer?: ReturnType<typeof setTimeout>
  manualDownloads?: ReturnType<typeof createSharedBrowserManualDownloads>
  compute?: ReturnType<typeof createSharedBrowserComputation>
  fileTransfer?: ReturnType<typeof createManagedBrowserFiles>
  fileReady: boolean
  fileAction?: SharedBrowserSchema.Action
  fileConfirming?: AbortController
  fileConfirmationTask?: Promise<FileDecision>
  fileConfirmations?: Map<
    string,
    { digest: string; value: Promise<FileDecision>; settled: { cancellation?: SharedBrowserFileSchema.Cancellation } }
  >
  leaseStartedAt?: number
  elapsedMs?: number
}
const digest = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
const immutable = (resource: SharedBrowserSchema.Resource) =>
  digest({
    resourceID: resource.resourceID,
    mainIncarnation: resource.mainIncarnation,
    scope: resource.scope,
    rootSessionID: resource.rootSessionID,
    requestID: resource.requestID,
    requestDigest: resource.requestDigest,
    policy: resource.policy,
    policyHash: resource.policyHash,
    policyRevision: resource.policyRevision ?? 1,
    expiresAt: resource.expiresAt,
  })
const leaseIdentity = (lease: SharedBrowserSchema.Lease) =>
  digest({
    leaseID: lease.leaseID,
    resourceID: lease.resourceID,
    mainIncarnation: lease.mainIncarnation,
    sidecarIncarnation: lease.sidecarIncarnation,
    scope: lease.scope,
    policyHash: lease.policyHash,
    leaseEpoch: lease.leaseEpoch,
    manualEpoch: lease.manualEpoch,
    expiresAt: lease.expiresAt,
  })
export class SharedBrowserMainError extends Error {
  constructor(readonly code: BrowserSchema.Error["code"]) {
    super(code)
  }
}
function fail(code: BrowserSchema.Error["code"]): never {
  throw new SharedBrowserMainError(code)
}

/** Created once in the actual Main process. Host disconnect revokes leases; it
 * does not dispose this registry, its partitions, or the user's live pages. */
export function createSharedBrowserManager(input: {
  mainIncarnation?: string
  onObservation?: (resource: SharedBrowserSchema.Resource, observation: SharedBrowserSchema.Observation) => void
}) {
  const mainIncarnation = input.mainIncarnation ?? randomUUID()
  const entries = new Map<string, Entry>()
  const hosts = new Map<string, (action: SharedBrowserSchema.Action) => Promise<boolean>>()
  const legacyHosts = new Map<string, { count: () => number; alive: () => boolean }>()
  const stamps = new Map<string, { digest: string; stamp: SharedBrowserSchema.InputStamp; sealed: boolean }>()
  const subscribers = new Set<NonNullable<typeof input.onObservation>>()
  let fileConfirmationOwner: ((resource: SharedBrowserSchema.Resource) => FileConfirmationOwner | undefined) | undefined
  let order = 0
  const physicalCount = () => {
    for (const [id, host] of legacyHosts) if (!host.alive() && host.count() === 0) legacyHosts.delete(id)
    return (
      [...entries.values()].filter((entry) => !entry.confirmed).length +
      [...legacyHosts.values()].reduce((count, host) => count + host.count(), 0)
    )
  }
  const nextOrder = () => {
    if (order >= Number.MAX_SAFE_INTEGER) fail("BROWSER_CAPACITY")
    return ++order
  }
  const entryFor = (id: string) => entries.get(id) ?? fail("BROWSER_NOT_FOUND")
  const elapsed = (entry: Entry) =>
    entry.leaseStartedAt === undefined ? entry.elapsedMs : Math.max(0, performance.now() - entry.leaseStartedAt)
  const freezeElapsed = (entry: Entry) => {
    entry.elapsedMs = elapsed(entry)
    entry.leaseStartedAt = undefined
  }
  const alive = (entry: Entry) =>
    entry.tabs.size > 0 &&
    [...entry.tabs.values()].every((tab) => !tab.window.isDestroyed() && !tab.window.webContents.isDestroyed())
  const observation = (entry: Entry): SharedBrowserSchema.Observation => ({
    resourceID: entry.resource.resourceID,
    mainIncarnation,
    manualEpoch: entry.resource.manualEpoch,
    barrierOrder: entry.resource.barrierOrder,
    resourceAlive: alive(entry),
    agentAccessFenced: entry.resource.agentAccessFenced,
    leaseRevoked: !entry.lease,
    ...entry.cleanup,
    manualEnabled: entry.resource.manualEnabled,
    unknownEffects: entry.unknownEffects,
    leaseID: entry.lease?.leaseID ?? null,
    leaseEpoch: entry.lease?.leaseEpoch ?? 0,
  })
  const publish = (entry: Entry) => {
    entry.resource = { ...entry.resource, resourceAlive: alive(entry), updatedAt: Date.now() }
    // UI connection loss must never interrupt an already-applied ownership fence.
    for (const listener of [input.onObservation, ...subscribers]) {
      try {
        listener?.(entry.resource, observation(entry))
      } catch {
        /* The Main registry remains authoritative when a view disappears. */
      }
    }
  }
  const assertResource = (resource: SharedBrowserSchema.Resource, reducing = false) => {
    const entry = entryFor(resource.resourceID)
    if (resource.mainIncarnation !== mainIncarnation) fail("BROWSER_AUTHORITY_REQUIRED")
    if (immutable(resource) !== entry.descriptor) {
      // A durable policy CAS may outlive its Main ACK. Closing that same owned
      // page must remain possible, but this path never installs the new policy.
      const manual = entry.policyPending && { ...entry.resource.policy,
        manualApprovedOrigins: [...entry.resource.policy.manualApprovedOrigins, entry.policyPending.command.origin] }
      const agent = SharedBrowserPolicy.agent(entry.resource.policy, resource.policy.approvedOrigins)
      if (!reducing || resource.policyRevision !== (entry.resource.policyRevision ?? 1) + 1 ||
        resource.policyHash !== digest(resource.policy) ||
        !(manual && SharedBrowserPolicy.same(manual, resource.policy) || agent && SharedBrowserPolicy.same(agent, resource.policy)) ||
        immutable({ ...resource, policy: entry.resource.policy, policyHash: entry.resource.policyHash,
          policyRevision: entry.resource.policyRevision }) !== entry.descriptor)
        fail("BROWSER_AUTHORITY_REQUIRED")
    }
    return entry
  }
  const checkLease = (entry: Entry, lease: SharedBrowserSchema.Lease) => {
    if (
      !entry.lease ||
      leaseIdentity(entry.lease) !== leaseIdentity(lease) ||
      entry.resource.state !== "agent_owned" ||
      entry.resource.agentAccessFenced ||
      entry.resource.manualEpoch !== lease.manualEpoch ||
      lease.expiresAt <= Date.now() ||
      !hosts.has(lease.sidecarIncarnation) ||
      !alive(entry)
    )
      fail("BROWSER_CANCELLED")
  }
  const manualPolicyCurrent = (entry: Entry, command: SharedBrowserSchema.ApproveOrigin) => {
    if (!alive(entry) || entry.resource.state !== "human_owned" || !entry.resource.manualEnabled ||
      !entry.resource.agentAccessFenced || entry.resource.liveLeaseID || entry.lease || entry.action ||
      entry.resource.manualEpoch !== command.expectedManualEpoch || entry.resource.expiresAt <= Date.now())
      fail("BROWSER_STALE_TARGET")
  }
  const pendingPolicy = (resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin, claim?: string) => {
    const entry = assertResource(resource)
    manualPolicyCurrent(entry, command)
    const pending = entry.policyPending
    if (!pending || digest(pending.command) !== digest(command) || !pending.current() ||
      command.expectedRevision !== entry.resource.revision || command.expectedPolicyHash !== entry.resource.policyHash ||
      claim !== undefined && pending.claim !== claim) fail("BROWSER_AUTHORITY_REQUIRED")
    return { entry, pending }
  }
  const fileCurrent = (resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease) => {
    const entry = assertResource(resource)
    checkLease(entry, lease)
    if (
      entry.resource.manualEnabled ||
      resource.revision !== entry.resource.revision ||
      resource.manualEpoch !== entry.resource.manualEpoch ||
      resource.liveLeaseID !== lease.leaseID ||
      resource.state !== "agent_owned" ||
      resource.agentAccessFenced
    )
      fail("BROWSER_CANCELLED")
    return entry
  }
  const currentNow = (entry: Entry, lease: SharedBrowserSchema.Lease, epoch: number) => {
    checkLease(entry, lease)
    if (entry.epoch !== epoch) fail("BROWSER_CANCELLED")
    const action = entry.context.getStore()
    if (!action) {
      if (!entry.attaching) fail("BROWSER_AUTHORITY_REQUIRED")
      return
    }
    if (entry.action !== action || action.deadline <= Date.now()) fail("BROWSER_CANCELLED")
  }
  const current = async (entry: Entry, lease: SharedBrowserSchema.Lease, epoch: number) => {
    currentNow(entry, lease, epoch)
    const action = entry.context.getStore()
    if (!action) fail("BROWSER_AUTHORITY_REQUIRED")
    if (!(await hosts.get(lease.sidecarIncarnation)?.(action))) fail("BROWSER_SCOPE_DENIED")
    currentNow(entry, lease, epoch)
  }
  const tabs = (entry: Entry): BrowserSchema.Tab[] =>
    [...entry.tabs.values()]
      .filter((tab) => !tab.window.isDestroyed())
      .map((tab) => ({
        tabID: tab.tabID,
        generation: tab.generation,
        url: (tab.window.webContents.getURL() || "about:blank").slice(0, 2048),
        title: tab.window.webContents.getTitle().slice(0, 256),
        selected: entry.selectedTabID === tab.tabID,
        canGoBack: tab.window.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.window.webContents.navigationHistory.canGoForward(),
      }))
  const installDriver = async (entry: Entry, tab: Tab) => {
    const lease = entry.lease ?? fail("BROWSER_CANCELLED")
    const epoch = entry.epoch
    const driver = createSharedBrowserDriver({
      contents: tab.window.webContents,
      current: () => current(entry, lease, epoch),
      currentNow: () => currentNow(entry, lease, epoch),
      setupCurrentNow: () => currentNowAfterSetup(entry, lease, epoch),
      generation: () => tab.generation,
      approvedOrigins: entry.resource.policy.approvedOrigins,
      witnessBudget: entry.witnessBudget,
      invalidated: () => entry.compute?.cancel(),
      dispatched: () => {
        currentNow(entry, lease, epoch)
        entry.dispatched = true
      },
      fail,
    })
    tab.driver = driver
    entry.attaching = true
    try {
      await driver.attach()
    } finally {
      entry.attaching = false
    }
    currentNowAfterSetup(entry, lease, epoch)
  }
  const currentNowAfterSetup = (entry: Entry, lease: SharedBrowserSchema.Lease, epoch: number) => {
    checkLease(entry, lease)
    if (entry.epoch !== epoch) fail("BROWSER_CANCELLED")
  }
  const createTab = async (entry: Entry) => {
    if (entry.tabs.size >= BrowserSchema.MAX_TABS) fail("BROWSER_CAPACITY")
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      focusable: false,
      title: "DeepAgent Code - Shared browser",
      webPreferences: {
        session: entry.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        backgroundThrottling: false,
      },
    })
    const tab: Tab = {
      tabID: randomUUID(),
      generation: 0,
      window,
      detachNetwork: entry.network!.attach(window.webContents),
    }
    entry.tabs.set(tab.tabID, tab)
    entry.selectedTabID ??= tab.tabID
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.on("show", () => {
      if (entry.resource.state !== "human_owned") window.hide()
    })
    window.webContents.on("will-navigate", (event, url) => {
      const approved =
        entry.resource.state === "human_owned"
          ? entry.resource.policy.manualApprovedOrigins
          : entry.resource.policy.approvedOrigins
      if (url !== "about:blank" && (!URL.canParse(url) || !approved.includes(new URL(url).origin)))
        event.preventDefault()
    })
    window.webContents.on("did-start-navigation", (_event, _url, same, main) => {
      if (!main || same) return
      tab.generation++
      tab.driver?.invalidate()
    })
    window.webContents.on("render-process-gone", () => {
      freezeElapsed(entry)
      entry.epoch++
      entry.lease = undefined
      entry.preview = undefined
      entry.compute?.cancel()
      entry.fileTransfer?.fence()
      entry.fileConfirming?.abort()
      entry.resource = {
        ...entry.resource,
        state: "resource_lost",
        agentAccessFenced: true,
        liveLeaseID: null,
        manualEnabled: false,
      }
      publish(entry)
    })
    window.on("close", (event) => {
      if (entry.resource.state === "closing" || entry.resource.state === "closed") return
      event.preventDefault()
      void close(entry.resource, {
        resourceID: entry.resource.resourceID,
        requestID: randomUUID(),
        expectedRevision: entry.resource.revision,
      })
    })
    await window.webContents.loadURL("about:blank")
    await installDriver(entry, tab)
    return tab
  }
  const bounded = async <T>(operation: Promise<T>, fallback: T) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<T>((accept) => {
          timer = setTimeout(() => accept(fallback), 2000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const cleanup = async (entry: Entry, epoch: number) => {
    const fallback = { inputIsolated: false, heldReleased: false, transportStopped: false, unknownEffects: true }
    const prior = entry.cleanupTask
    if (!prior || prior.epoch !== epoch || prior.settled) {
      const networkStopped = entry.network!.quiesce(epoch)
      const filesStopped = networkStopped.then(async (network) => {
        if (!network.closed) return false
        if (!entry.fileTransfer) return true
        if (!(await entry.fileTransfer.close())) return false
        entry.fileTransfer = undefined
        entry.fileAction = undefined
        return true
      })
      const task = {
        epoch,
        settled: false,
        promise: Promise.all([
          filesStopped.then((stopped) =>
            Promise.all(
              [...entry.tabs.values()].map(async (tab) => {
                if (!stopped) return { heldReleased: false, transportStopped: false }
                const driver = tab.driver
                const value = driver ? await driver.cleanup() : { heldReleased: true, transportStopped: true }
                if (entry.epoch === epoch && tab.driver === driver && value.heldReleased && value.transportStopped)
                  tab.driver = undefined
                return value
              }),
            ),
          ),
          networkStopped,
          // Fencing denies guest effects immediately, but manual ownership is not
          // enabled until the original computation thread has actually exited.
          entry.compute?.result.then(
            () => true,
            () => true,
          ) ?? Promise.resolve(true),
          entry.fileConfirmationTask?.then(
            () => true,
            () => true,
          ) ?? Promise.resolve(true),
        ])
          .then(([drivers, network, computationStopped, confirmationStopped]) => ({
            inputIsolated:
              computationStopped && confirmationStopped && drivers.every((value) => value.transportStopped),
            heldReleased: drivers.every((value) => value.heldReleased),
            transportStopped:
              computationStopped &&
              confirmationStopped &&
              network.closed &&
              drivers.every((value) => value.transportStopped),
            unknownEffects: network.unknownEffects,
          }))
          .catch(() => fallback),
      }
      entry.cleanupTask = task
      void task.promise.then(() => {
        task.settled = true
      })
    }
    const result = await bounded(entry.cleanupTask!.promise, fallback)
    if (entry.epoch !== epoch || ["closing", "closed", "resource_lost"].includes(entry.resource.state))
      return observation(entry)
    entry.cleanup = result
    entry.unknownEffects ||= result.unknownEffects
    const manual = result.inputIsolated && result.heldReleased && result.transportStopped && alive(entry)
    entry.resource = { ...entry.resource, state: manual ? "human_owned" : "fenced_blocked", manualEnabled: manual }
    if (manual && entry.network!.resume(epoch)) {
      entry.manualDownloads!.enable(entry.resource.manualEpoch)
      const tab = entry.tabs.get(entry.selectedTabID ?? "") ?? entry.tabs.values().next().value
      tab?.window.setFocusable(true)
      tab?.window.show()
      tab?.window.focus()
    } else {
      entry.resource = { ...entry.resource, state: "fenced_blocked", manualEnabled: false }
    }
    publish(entry)
    return observation(entry)
  }
  const beginTakeover = (
    resource: SharedBrowserSchema.Resource,
    request: SharedBrowserSchema.Takeover,
    reason: SharedBrowserSchema.BarrierTicket["reason"] = "human_takeover",
  ) => {
    const entry = assertResource(resource)
    if (entry.takeover?.request.requestID === request.requestID) {
      if (digest(entry.takeover.request) !== digest(request)) fail("BROWSER_CONFLICT")
      if (entry.resource.state === "fenced_blocked") {
        entry.resource = { ...entry.resource, state: "takeover_pending", manualEnabled: false }
        entry.takeover.completion = cleanup(entry, entry.epoch)
        publish(entry)
      }
      return { ticket: entry.takeover.ticket, completion: entry.takeover.completion }
    }
    if (entry.takeover && !entry.takeover.committed) fail("BROWSER_CONFLICT")
    if (
      request.expectedRevision !== resource.revision ||
      resource.manualEpoch !== entry.resource.manualEpoch ||
      ["closed", "closing", "resource_lost"].includes(entry.resource.state)
    )
      fail("BROWSER_STALE_TARGET")
    entry.epoch++
    entry.compute?.cancel()
    entry.fileTransfer?.fence()
    entry.fileConfirming?.abort()
    freezeElapsed(entry)
    clearTimeout(entry.timer)
    entry.preview = undefined
    entry.unknownEffects ||= !!entry.action && entry.dispatched
    const ticket: SharedBrowserSchema.BarrierTicket = {
      resourceID: resource.resourceID,
      rootSessionID: resource.rootSessionID,
      mainIncarnation,
      requestID: request.requestID,
      expectedRevision: request.expectedRevision,
      manualEpoch: entry.resource.manualEpoch + 1,
      barrierOrder: nextOrder(),
      reason,
    }
    entry.lease = undefined
    entry.resource = {
      ...entry.resource,
      state: "takeover_pending",
      manualEpoch: ticket.manualEpoch,
      barrierOrder: ticket.barrierOrder,
      liveLeaseID: null,
      agentAccessFenced: true,
      manualEnabled: false,
    }
    const completion = cleanup(entry, entry.epoch)
    entry.takeover = { request, ticket, completion, committed: false }
    publish(entry)
    return { ticket, completion }
  }
  const close = (resource: SharedBrowserSchema.Resource, request: SharedBrowserSchema.Close) => {
    const entry = assertResource(resource, true)
    if (entry.pendingClose) {
      if (digest(entry.pendingClose) !== digest(request)) fail("BROWSER_CONFLICT")
      if (entry.closeWaiting || entry.confirmed) return entry.closePromise!
    } else {
      if (
        request.expectedRevision !== resource.revision &&
        !(
          resource.state === "closing" &&
          resource.revision === request.expectedRevision + 1 &&
          [request.expectedRevision, resource.revision].includes(entry.resource.revision)
        )
      )
        fail("BROWSER_STALE_TARGET")
      entry.pendingClose = request
      freezeElapsed(entry)
      entry.epoch++
      entry.lease = undefined
      entry.preview = undefined
      entry.compute?.cancel()
      entry.fileTransfer?.fence()
      entry.fileConfirming?.abort()
      clearTimeout(entry.timer)
    }
    entry.resource = {
      ...entry.resource,
      state: "closing",
      agentAccessFenced: true,
      liveLeaseID: null,
      manualEnabled: false,
    }
    publish(entry)
    if (!entry.closeTask || entry.closeTask.settled) {
      const task = {
        settled: false,
        promise: (async () => {
          const [network, downloads, computationStopped, confirmationStopped] = await Promise.all([
            entry.network?.close(),
            entry.manualDownloads!.close(),
            entry.compute?.result.then(
              () => true,
              () => true,
            ) ?? Promise.resolve(true),
            entry.fileConfirmationTask?.then(
              () => true,
              () => true,
            ) ?? Promise.resolve(true),
          ])
          const windows = await Promise.all(
            [...entry.tabs.values()].map(
              (tab) =>
                new Promise<boolean>((accept) => {
                  if (tab.window.isDestroyed()) {
                    accept(true)
                    return
                  }
                  tab.detachNetwork()
                  tab.window.once("closed", () => accept(true))
                  tab.window.destroy()
                }),
            ),
          )
          const filesStopped = network === true && (!entry.fileTransfer || (await entry.fileTransfer.close()))
          if (filesStopped) {
            entry.fileTransfer = undefined
            entry.fileAction = undefined
          }
          entry.resource = {
            ...entry.resource,
            state:
              network &&
              downloads &&
              filesStopped &&
              computationStopped &&
              confirmationStopped &&
              windows.every(Boolean)
                ? "closed"
                : "recovery_required",
          }
          entry.unknownEffects ||= !downloads
          entry.confirmed =
            network === true &&
            downloads &&
            filesStopped &&
            computationStopped &&
            confirmationStopped &&
            windows.every(Boolean) &&
            [...entry.tabs.values()].every((tab) => tab.window.isDestroyed())
          entry.cleanup = {
            inputIsolated: windows.every(Boolean),
            heldReleased: windows.every(Boolean),
            transportStopped:
              network === true && downloads && filesStopped && computationStopped && confirmationStopped,
          }
          publish(entry)
          return observation(entry)
        })(),
      }
      entry.closeTask = task
      void task.promise.then(
        () => {
          task.settled = true
        },
        () => {
          task.settled = true
        },
      )
    }
    entry.closeWaiting = true
    entry.closePromise = bounded(entry.closeTask.promise, { ...observation(entry), manualEnabled: false }).finally(
      () => {
        entry.closeWaiting = false
      },
    )
    return entry.closePromise
  }
  const armLease = (entry: Entry) => {
    clearTimeout(entry.timer)
    const lease = entry.lease
    if (!lease) return
    entry.timer = setTimeout(
      () => {
        if (entry.lease !== lease) return
        beginTakeover(
          entry.resource,
          { resourceID: entry.resource.resourceID, requestID: randomUUID(), expectedRevision: entry.resource.revision },
          "lease_expired",
        )
      },
      Math.max(1, Math.min(lease.expiresAt, entry.resource.expiresAt) - Date.now()),
    )
  }
  return {
    mainIncarnation,
    nextOrder,
    physicalCount,
    registerFileConfirmationOwner(
      resolve: (resource: SharedBrowserSchema.Resource) => FileConfirmationOwner | undefined,
    ) {
      if (fileConfirmationOwner) fail("BROWSER_CONFLICT")
      fileConfirmationOwner = resolve
      return () => {
        if (fileConfirmationOwner === resolve) fileConfirmationOwner = undefined
      }
    },
    fileCurrent(resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease) {
      fileCurrent(resource, lease)
      return true
    },
    fileReady(resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease) {
      const entry = fileCurrent(resource, lease)
      // Set only after this Main initialized the original partition, broker and
      // driver. Host separately requires its live native custody factory.
      return entry.fileReady && !!(resource.policy.filePolicy?.upload || resource.policy.filePolicy?.download)
    },
    fileCancellation(
      resource: SharedBrowserSchema.Resource,
      lease: SharedBrowserSchema.Lease,
      preview: SharedBrowserFileSchema.Preview,
      command: SharedBrowserFileSchema.Approve,
    ) {
      const entry = assertResource(resource)
      const prior = entry.fileConfirmations?.get(command.requestID)
      if (!prior) return
      if (prior.digest !== digest({ lease: leaseIdentity(lease), preview, command })) fail("BROWSER_CONFLICT")
      // Read an already-established refusal after lease retirement without
      // acquiring authority, waiting for a dialog, or creating a new operation.
      return prior.settled.cancellation
    },
    confirmFile(
      resource: SharedBrowserSchema.Resource,
      lease: SharedBrowserSchema.Lease,
      preview: SharedBrowserFileSchema.Preview,
      command: SharedBrowserFileSchema.Approve,
      check: () => Promise<void>,
    ) {
      const entry = fileCurrent(resource, lease)
      const binding = SharedBrowserFileBinding.from(entry.resource, lease)
      const bindingHash = digest(binding)
      if (
        !resource.policy.filePolicy?.[preview.direction] ||
        digest(preview.binding) !== bindingHash ||
        preview.bindingHash !== bindingHash ||
        preview.scopeHash !== binding.scopeHash ||
        command.expectedResourceRevision !== resource.revision ||
        command.expectedLeaseID !== lease.leaseID ||
        command.expectedLeaseEpoch !== lease.leaseEpoch ||
        command.expectedManualEpoch !== lease.manualEpoch ||
        command.expiresAt <= Date.now() ||
        command.expiresAt > Math.min(lease.expiresAt, resource.expiresAt) ||
        !resource.policy.approvedOrigins.includes(new URL(preview.targetURL).origin)
      )
        fail("BROWSER_SCOPE_DENIED")
      const key = digest({ lease: leaseIdentity(lease), preview, command })
      entry.fileConfirmations ??= new Map()
      const prior = entry.fileConfirmations.get(command.requestID)
      if (prior) {
        if (prior.digest !== key) fail("BROWSER_CONFLICT")
        return prior.value
      }
      if (entry.action || entry.queue || entry.fileConfirming) fail("BROWSER_CONFLICT")
      if (entry.fileConfirmations.size >= 64) fail("BROWSER_CAPACITY")
      // Agent pages stay hidden. Only the original registered DAC renderer may
      // own a native approval sheet, never a website or an arbitrary focused window.
      const owner = fileConfirmationOwner?.(resource) ?? fail("BROWSER_AUTHORITY_REQUIRED")
      const owned = new AbortController()
      const epoch = entry.epoch
      entry.fileConfirming = owned
      const current = async () => {
        if (owned.signal.aborted || command.expiresAt <= Date.now() || entry.epoch !== epoch) fail("BROWSER_CANCELLED")
        if (
          owner.window.isDestroyed() ||
          owner.window.webContents.isDestroyed() ||
          !owner.window.isVisible() ||
          owner.window.isMinimized() ||
          !owner.window.isFocusable() ||
          !owner.current()
        )
          fail("BROWSER_AUTHORITY_REQUIRED")
        fileCurrent(resource, lease)
        await check()
        if (owned.signal.aborted || command.expiresAt <= Date.now() || entry.epoch !== epoch) fail("BROWSER_CANCELLED")
        if (
          owner.window.isDestroyed() ||
          owner.window.webContents.isDestroyed() ||
          !owner.window.isVisible() ||
          owner.window.isMinimized() ||
          !owner.window.isFocusable() ||
          !owner.current()
        )
          fail("BROWSER_AUTHORITY_REQUIRED")
        fileCurrent(resource, lease)
      }
      const timer = setTimeout(() => owned.abort(), Math.max(1, command.expiresAt - Date.now()))
      const settled: { cancellation?: SharedBrowserFileSchema.Cancellation } = {}
      const value = (async (): Promise<FileDecision> => {
        try {
          await current()
          const tab = entry.tabs.get(entry.selectedTabID ?? "")
          if (!tab || tab.window.isDestroyed()) fail("BROWSER_STALE_TARGET")
          const selected = await dialog.showMessageBox(owner.window, {
            type: "warning",
            buttons: ["Cancel", "Allow once"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: owned.signal,
            title: "DeepAgent · File exchange",
            message:
              preview.direction === "upload"
                ? "Send this project file once?"
                : "Save this download as a new project file?",
            detail: `${resource.scope.directory}\n${preview.relative}\n${preview.targetURL}\n${
              preview.direction === "upload"
                ? `${preview.bytes} bytes · SHA-256 ${preview.sha256}`
                : `Up to ${preview.maxBytes} bytes · Existing files will not be replaced`
            }\nApproval expires: ${new Date(command.expiresAt).toISOString()}`,
          })
          if (owned.signal.aborted || (selected.response !== 0 && selected.response !== 1)) fail("BROWSER_SCOPE_DENIED")
          await current()
          if (selected.response === 0) {
            settled.cancellation = {
              kind: "cancelled",
              resourceID: resource.resourceID,
              requestID: command.requestID,
              bindingHash,
              previewHash: digest(preview),
              commandHash: digest(command),
              cancelledAt: Date.now(),
            }
            return settled.cancellation
          }
          const confirmedAt = Date.now()
          return {
            previewHash: digest(preview),
            commandHash: digest(command),
            confirmedAt,
            confirmationHash: digest([
              "dac.browser.native-file-confirm.v2",
              bindingHash,
              digest(preview),
              digest(command),
              confirmedAt,
              randomUUID(),
            ]),
          }
        } finally {
          clearTimeout(timer)
          if (entry.fileConfirming === owned) entry.fileConfirming = undefined
        }
      })()
      entry.fileConfirmationTask = value
      entry.fileConfirmations.set(command.requestID, { digest: key, value, settled })
      return value
    },
    registerLegacyHost(incarnation: string, host: { count: () => number; alive: () => boolean }) {
      if (legacyHosts.has(incarnation)) fail("BROWSER_CONFLICT")
      physicalCount()
      legacyHosts.set(incarnation, host)
    },
    subscribe(listener: NonNullable<typeof input.onObservation>) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    attachHost(incarnation: string, authorize: (action: SharedBrowserSchema.Action) => Promise<boolean>) {
      hosts.set(incarnation, authorize)
    },
    hostLost(incarnation: string) {
      hosts.delete(incarnation)
      for (const entry of entries.values())
        if (entry.lease?.sidecarIncarnation === incarnation)
          beginTakeover(
            entry.resource,
            {
              resourceID: entry.resource.resourceID,
              requestID: randomUUID(),
              expectedRevision: entry.resource.revision,
            },
            "sidecar_lost",
          )
    },
    stamp(value: Omit<SharedBrowserSchema.InputStamp, "mainIncarnation" | "submissionOrder" | "promptHash">) {
      const key = value.rootSessionID + "/" + value.originalSubmissionID
      const prior = stamps.get(key)
      if (prior) {
        if (prior.digest !== digest(value)) fail("BROWSER_CONFLICT")
        return prior.stamp
      }
      if (
        [...entries.values()].some(
          (entry) =>
            entry.resource.rootSessionID === value.rootSessionID && entry.takeover && !entry.takeover.committed,
        )
      )
        fail("BROWSER_CONFLICT")
      if (stamps.size >= BrowserSchema.MAX_ACTIONS) fail("BROWSER_CAPACITY")
      const stamp = Schema.decodeUnknownSync(SharedBrowserSchema.InputStamp)({
        ...value,
        mainIncarnation,
        submissionOrder: nextOrder(),
      })
      stamps.set(key, { digest: digest(value), stamp, sealed: false })
      return stamp
    },
    seal(stamp: SharedBrowserSchema.InputStamp, promptHash: string) {
      const entry = stamps.get(stamp.rootSessionID + "/" + stamp.originalSubmissionID)
      if (!entry || stamp.mainIncarnation !== mainIncarnation) fail("BROWSER_AUTHORITY_REQUIRED")
      const { promptHash: requestedHash, ...original } = stamp
      const { promptHash: recordedHash, ...recorded } = entry.stamp
      if (
        digest(original) !== digest(recorded) ||
        (requestedHash !== undefined && requestedHash !== promptHash) ||
        (entry.sealed && recordedHash !== promptHash)
      )
        fail("BROWSER_CONFLICT")
      if (entry.sealed) return entry.stamp
      entry.stamp = Schema.decodeUnknownSync(SharedBrowserSchema.InputStamp)({ ...original, promptHash })
      entry.sealed = true
      return entry.stamp
    },
    validateInput(stamp: SharedBrowserSchema.InputStamp) {
      const entry = stamps.get(stamp.rootSessionID + "/" + stamp.originalSubmissionID)
      return (
        stamp.mainIncarnation === mainIncarnation && entry?.sealed === true && digest(entry.stamp) === digest(stamp)
      )
    },
    retireSource(sourceBindingHash: string) {
      for (const [key, value] of stamps)
        if (!value.sealed && value.stamp.sourceBindingHash === sourceBindingHash) stamps.delete(key)
    },
    list(rootSessionID: string) {
      return [...entries.values()]
        .filter((entry) => entry.resource.rootSessionID === rootSessionID)
        .map((entry) => ({ ...entry.resource }))
    },
    getView(resourceID: string) {
      const entry = entryFor(resourceID)
      return {
        resource: { ...entry.resource },
        elapsedMs: elapsed(entry),
        pendingTakeover:
          entry.takeover && ["takeover_pending", "fenced_blocked", "recovery_required"].includes(entry.resource.state)
            ? entry.takeover.request
            : undefined,
        pendingClose: entry.pendingClose,
        pendingOrigin: entry.policyPending?.command,
      }
    },
    preview(resourceID: string, rootSessionID: string, expectedManualEpoch: number) {
      const entry = entryFor(resourceID)
      if (
        entry.resource.rootSessionID !== rootSessionID ||
        entry.resource.manualEpoch !== expectedManualEpoch ||
        entry.resource.state !== "agent_owned" ||
        entry.resource.agentAccessFenced
      )
        return undefined
      return entry.preview
    },
    beginTakeover,
    async confirmBarrier(resource: SharedBrowserSchema.Resource, ticket: SharedBrowserSchema.BarrierTicket) {
      const entry = assertResource(resource)
      if (
        !entry.takeover ||
        digest(entry.takeover.ticket) !== digest(ticket) ||
        entry.resource.manualEpoch !== ticket.manualEpoch ||
        resource.barrierOrder !== ticket.barrierOrder ||
        resource.coreCutoff < -1
      )
        fail("BROWSER_AUTHORITY_REQUIRED")
      entry.takeover.committed = true
      entry.resource = { ...entry.resource, coreCutoff: resource.coreCutoff, revision: resource.revision }
      return entry.takeover.completion
    },
    async create(resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease) {
      if (!app.commandLine.hasSwitch("disable-quic")) fail("BROWSER_DRIVER_UNAVAILABLE")
      if (
        resource.mainIncarnation !== mainIncarnation ||
        digest(resource.policy) !== resource.policyHash ||
        resource.rootSessionID !== resource.scope.sessionID ||
        lease.resourceID !== resource.resourceID ||
        lease.mainIncarnation !== mainIncarnation ||
        lease.policyHash !== resource.policyHash ||
        digest(lease.scope) !== digest(resource.scope) ||
        lease.expiresAt > resource.expiresAt ||
        !hosts.has(lease.sidecarIncarnation)
      )
        fail("BROWSER_AUTHORITY_REQUIRED")
      const prior = entries.get(resource.resourceID)
      if (prior) {
        if (
          prior.descriptor !== immutable(resource) ||
          !prior.lease ||
          leaseIdentity(prior.lease) !== leaseIdentity(lease)
        )
          fail("BROWSER_CONFLICT")
        return observation(prior)
      }
      if (entries.size >= BrowserSchema.MAX_CONTROLS || physicalCount() >= BrowserSchema.MAX_ACTIVE_CONTROLS)
        fail("BROWSER_CAPACITY")
      const entry: Entry = {
        resource: {
          ...resource,
          state: "agent_owned",
          agentAccessFenced: false,
          manualEnabled: false,
          liveLeaseID: lease.leaseID,
        },
        descriptor: immutable(resource),
        policyOwners: new Map(),
        lease,
        epoch: 0,
        partition: session.fromPartition("dac-shared-" + randomUUID(), { cache: false }),
        tabs: new Map(),
        witnessBudget: createSharedBrowserWitnessBudget(),
        context: new AsyncLocalStorage(),
        attaching: false,
        dispatched: false,
        queue: 0,
        chain: Promise.resolve(),
        seen: new Set(),
        usedInputs: new Set(),
        unknownEffects: false,
        confirmed: false,
        fileReady: false,
        cleanup: { inputIsolated: false, heldReleased: false, transportStopped: false },
      }
      entries.set(resource.resourceID, entry)
      entry.partition.setPermissionCheckHandler(() => false)
      entry.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      entry.partition.setDevicePermissionHandler(() => false)
      entry.partition.setDisplayMediaRequestHandler((_request, callback) => callback({}))
      entry.manualDownloads = createSharedBrowserManualDownloads({
        partition: entry.partition,
        current: () => entry.resource,
        approvedOrigins: () => entry.resource.policy.manualApprovedOrigins,
        owns: (contents) =>
          [...entry.tabs.values()].some((tab) => !tab.window.isDestroyed() && tab.window.webContents === contents),
      })
      try {
        entry.network = await createSharedBrowserNetwork({
          partition: entry.partition,
          policy: resource.policy,
          onAllocated: (network) => {
            entry.network = network
          },
          current: () => ({ epoch: entry.epoch, state: entry.resource.state, action: entry.action, policy: entry.resource.policy }),
          file: () =>
            entry.fileAction && entry.fileTransfer
              ? { action: entry.fileAction, transfer: entry.fileTransfer }
              : undefined,
          owns: (contents) =>
            [...entry.tabs.values()].some((tab) => !tab.window.isDestroyed() && tab.window.webContents === contents),
        })
        await createTab(entry)
        entry.fileReady = true
        entry.leaseStartedAt = performance.now()
        entry.elapsedMs = 0
        armLease(entry)
        publish(entry)
        return observation(entry)
      } catch (error) {
        if (!entry.resource.agentAccessFenced)
          await close(entry.resource, {
            resourceID: resource.resourceID,
            requestID: randomUUID(),
            expectedRevision: entry.resource.revision,
          })
        throw error
      }
    },
    status(resourceID: string) {
      return observation(entryFor(resourceID))
    },
    prepareOrigin(resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin,
      owner: string, current: () => boolean) {
      const entry = assertResource(resource)
      manualPolicyCurrent(entry, command)
      if (!current()) fail("BROWSER_AUTHORITY_REQUIRED")
      if (entry.policyPending) {
        if (entry.policyPending.owner !== owner || digest(entry.policyPending.command) !== digest(command))
          fail("BROWSER_CONFLICT")
        return
      }
      const prior = entry.resource.policyApprovals?.find((receipt) => receipt.requestID === command.requestID)
      if (prior) {
        if (prior.requestHash !== digest(command) || entry.policyOwners.get(command.requestID) !== owner)
          fail("BROWSER_CONFLICT")
      } else if (command.expectedRevision !== entry.resource.revision || command.expectedPolicyHash !== entry.resource.policyHash ||
        entry.resource.policy.manualApprovedOrigins.includes(command.origin) || entry.resource.policy.manualApprovedOrigins.length >= 8)
        fail("BROWSER_CONFLICT")
      entry.policyPending = { command, owner, current }
      publish(entry)
    },
    claimPolicy(resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin) {
      const { pending } = pendingPolicy(resource, command)
      if (pending.claim) fail("BROWSER_CONFLICT")
      pending.claim = randomUUID()
      return pending.claim
    },
    cancelOrigin(resourceID: string, command: SharedBrowserSchema.ApproveOrigin, owner: string) {
      const entry = entryFor(resourceID)
      manualPolicyCurrent(entry, command)
      if (command.resourceID !== resourceID) fail("BROWSER_SCOPE_DENIED")
      const pending = entry.policyPending
      if (pending) {
        if (pending.owner !== owner || digest(pending.command) !== digest(command)) fail("BROWSER_CONFLICT")
        if (pending.claim) return false
        entry.policyPending = undefined
        publish(entry)
        return true
      }
      // Every uncertain claim is retained for this Main lifetime. Absence plus
      // no committed receipt proves this exact request did not commit here.
      return !entry.resource.policyApprovals?.some((receipt) => receipt.requestID === command.requestID)
    },
    checkPolicy(resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin, claim?: string) {
      if (!claim) fail("BROWSER_AUTHORITY_REQUIRED")
      return observation(pendingPolicy(resource, command, claim).entry)
    },
    abortPolicy(resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin, claim?: string) {
      const entry = entryFor(resource.resourceID)
      if (resource.mainIncarnation !== mainIncarnation || !claim || entry.policyPending?.claim !== claim ||
        digest(entry.policyPending.command) !== digest(command)) fail("BROWSER_AUTHORITY_REQUIRED")
      entry.policyPending = undefined
      publish(entry)
      return observation(entry)
    },
    commitPolicy(resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin) {
      const entry = entryFor(resource.resourceID)
      manualPolicyCurrent(entry, command)
      const pending = entry.policyPending
      const receipt = resource.policyApprovals?.find((value) => value.requestID === command.requestID)
      if (!pending || !pending.current() || digest(pending.command) !== digest(command) ||
        !receipt || receipt.requestHash !== digest(command) || receipt.manualEpoch !== command.expectedManualEpoch)
        fail("BROWSER_AUTHORITY_REQUIRED")
      if (immutable(resource) !== entry.descriptor) {
        const policy = { ...entry.resource.policy, manualApprovedOrigins: [...entry.resource.policy.manualApprovedOrigins, command.origin] }
        if (!pending.claim || command.expectedRevision !== entry.resource.revision ||
          command.expectedPolicyHash !== entry.resource.policyHash || resource.revision !== command.expectedRevision + 1 ||
          receipt.baseRevision !== command.expectedRevision || receipt.revision !== resource.revision ||
          resource.policyRevision !== (entry.resource.policyRevision ?? 1) + 1 || receipt.policyRevision !== resource.policyRevision ||
          resource.policyHash !== digest(policy) || receipt.policyHash !== resource.policyHash ||
          !SharedBrowserPolicy.same(resource.policy, policy) || resource.state !== "human_owned" ||
          resource.manualEpoch !== entry.resource.manualEpoch || !resource.manualEnabled || !resource.agentAccessFenced ||
          !resource.resourceAlive || resource.liveLeaseID ||
          immutable({ ...resource, policy: entry.resource.policy, policyHash: entry.resource.policyHash,
            policyRevision: entry.resource.policyRevision }) !== entry.descriptor)
          fail("BROWSER_AUTHORITY_REQUIRED")
        entry.resource = resource
        entry.descriptor = immutable(resource)
        entry.policyOwners.set(command.requestID, pending.owner)
      } else if (entry.policyOwners.get(command.requestID) !== pending.owner) fail("BROWSER_AUTHORITY_REQUIRED")
      entry.policyPending = undefined
      publish(entry)
      return observation(entry)
    },
    syncProjection(resource: SharedBrowserSchema.Resource) {
      const entry = assertResource(resource)
      if (
        resource.manualEpoch !== entry.resource.manualEpoch ||
        resource.barrierOrder !== entry.resource.barrierOrder ||
        resource.revision < entry.resource.revision
      )
        fail("BROWSER_STALE_TARGET")
      entry.resource = { ...entry.resource, revision: resource.revision, updatedAt: resource.updatedAt }
      publish(entry)
      return observation(entry)
    },
    async acquire(
      resource: SharedBrowserSchema.Resource,
      lease: SharedBrowserSchema.Lease,
      witness: SharedBrowserSchema.UserWitness,
    ) {
      const entry = entryFor(resource.resourceID)
      if (immutable(resource) !== entry.descriptor) {
        const policy = SharedBrowserPolicy.agent(entry.resource.policy, resource.policy.approvedOrigins)
        if (!policy || SharedBrowserPolicy.same(policy, entry.resource.policy) ||
          !SharedBrowserPolicy.same(policy, resource.policy) || digest(policy) !== resource.policyHash ||
          resource.policyRevision !== (entry.resource.policyRevision ?? 1) + 1 ||
          resource.revision !== entry.resource.revision + 1 ||
          immutable({ ...resource, policy: entry.resource.policy, policyHash: entry.resource.policyHash,
            policyRevision: entry.resource.policyRevision }) !== entry.descriptor)
          fail("BROWSER_AUTHORITY_REQUIRED")
      }
      if (entry.policyPending) fail("BROWSER_CONFLICT")
      if (
        !entry.takeover?.committed ||
        entry.resource.state !== "human_owned" ||
        !entry.resource.manualEnabled ||
        lease.manualEpoch !== entry.resource.manualEpoch ||
        lease.resourceID !== resource.resourceID ||
        lease.mainIncarnation !== mainIncarnation ||
        lease.policyHash !== resource.policyHash ||
        digest(lease.scope) !== digest(resource.scope) ||
        witness.rootSessionID !== resource.rootSessionID ||
        witness.mainIncarnation !== mainIncarnation ||
        witness.submissionOrder <= entry.resource.barrierOrder ||
        witness.admittedSeq <= entry.resource.coreCutoff ||
        lease.originInputID !== witness.inputID ||
        entry.usedInputs.has(witness.inputID) ||
        !hosts.has(lease.sidecarIncarnation) ||
        ![...stamps.values()].some(
          ({ stamp, sealed }) =>
            sealed &&
            stamp.inputID === witness.inputID &&
            stamp.rootSessionID === witness.rootSessionID &&
            stamp.mainIncarnation === witness.mainIncarnation &&
            stamp.submissionOrder === witness.submissionOrder,
        )
      )
        fail("BROWSER_AUTHORITY_REQUIRED")
      const download = entry.manualDownloads!.status()
      if (download) fail(download === "active" ? "BROWSER_CONFLICT" : "BROWSER_UNKNOWN")
      entry.epoch++
      const epoch = entry.epoch
      entry.resource = { ...entry.resource, state: "acquire_pending", manualEnabled: false }
      for (const tab of entry.tabs.values()) {
        tab.window.setFocusable(false)
        tab.window.hide()
      }
      const stopped = await bounded(entry.network!.quiesce(epoch), { closed: false, unknownEffects: true })
      if (entry.epoch !== epoch) fail("BROWSER_CANCELLED")
      entry.unknownEffects ||= stopped.unknownEffects
      if (
        !stopped.closed ||
        [...entry.tabs.values()].some((tab) => {
          const url = tab.window.webContents.getURL()
          return (
            url !== "about:blank" &&
            (!URL.canParse(url) || !resource.policy.approvedOrigins.includes(new URL(url).origin))
          )
        })
      ) {
        entry.resource = { ...entry.resource, state: "fenced_blocked", agentAccessFenced: true }
        publish(entry)
        fail("BROWSER_SCOPE_DENIED")
      }
      entry.lease = lease
      entry.descriptor = immutable(resource)
      entry.resource = {
        ...resource,
        state: "agent_owned",
        agentAccessFenced: false,
        manualEnabled: false,
        liveLeaseID: lease.leaseID,
      }
      entry.cleanup = { inputIsolated: false, heldReleased: false, transportStopped: false }
      if (!entry.network!.resume(epoch)) fail("BROWSER_DRIVER_UNAVAILABLE")
      try {
        for (const tab of entry.tabs.values()) await installDriver(entry, tab)
      } catch (error) {
        entry.epoch++
        entry.lease = undefined
        entry.preview = undefined
        entry.resource = {
          ...entry.resource,
          state: "fenced_blocked",
          agentAccessFenced: true,
          manualEnabled: false,
          liveLeaseID: null,
        }
        await cleanup(entry, entry.epoch)
        throw error
      }
      entry.leaseStartedAt = performance.now()
      entry.elapsedMs = 0
      publish(entry)
      entry.usedInputs.add(witness.inputID)
      armLease(entry)
      return observation(entry)
    },
    async execute(
      resource: SharedBrowserSchema.Resource,
      lease: SharedBrowserSchema.Lease,
      action: SharedBrowserSchema.Action,
      file?: {
        pairs: readonly { grant: SharedBrowserFileSchema.Grant; artifact: SharedBrowserFileSchema.Artifact }[]
        ask: Parameters<typeof createManagedBrowserFiles>[0]["ask"]
      },
    ) {
      const entry = assertResource(resource)
      checkLease(entry, lease)
      if (
        action.resourceID !== resource.resourceID ||
        action.leaseID !== lease.leaseID ||
        action.leaseEpoch !== lease.leaseEpoch ||
        action.manualEpoch !== lease.manualEpoch ||
        action.rootSessionID !== resource.rootSessionID ||
        action.commandHash !== digest(action.command) ||
        action.deadline > Math.min(Date.now() + BrowserSchema.MAX_TIMEOUT_MS, lease.expiresAt)
      )
        fail("BROWSER_AUTHORITY_REQUIRED")
      if (entry.fileConfirming) fail("BROWSER_CONFLICT")
      if (entry.seen.has(action.actionID)) fail("BROWSER_UNKNOWN")
      if (entry.seen.size >= BrowserSchema.MAX_ACTIONS || entry.queue >= BrowserSchema.MAX_WAITING)
        fail("BROWSER_CAPACITY")
      entry.seen.add(action.actionID)
      entry.queue++
      const epoch = entry.epoch
      const finished = Promise.withResolvers<never>()
      let timer: ReturnType<typeof setTimeout> | undefined
      const operation = entry.chain.then(() =>
        entry.context.run(action, async () => {
          entry.action = action
          entry.dispatched = false
          timer = setTimeout(
            () => {
              if (entry.action !== action) return
              beginTakeover(
                entry.resource,
                {
                  resourceID: entry.resource.resourceID,
                  requestID: randomUUID(),
                  expectedRevision: entry.resource.revision,
                },
                "action_timeout",
              )
              finished.reject(new SharedBrowserMainError(entry.dispatched ? "BROWSER_UNKNOWN" : "BROWSER_CANCELLED"))
            },
            Math.max(1, action.deadline - Date.now()),
          )
          try {
            await current(entry, lease, epoch)
            const command = action.command
            if (command.type === "tabs.list" || command.type === "files.list") return { result: { tabs: tabs(entry) } }
            if (command.type === "tabs.create") {
              const tab = await createTab(entry)
              if (command.url) {
                await current(entry, lease, epoch)
                await tab.window.webContents.loadURL(command.url)
              }
              currentNow(entry, lease, epoch)
              return { result: { tabs: tabs(entry) } }
            }
            if (!("tabID" in command)) fail("BROWSER_SCOPE_DENIED")
            const tab = entry.tabs.get(command.tabID)
            if (!tab || tab.generation !== command.generation || !tab.driver) fail("BROWSER_STALE_TARGET")
            const contents = tab.window.webContents
            if (command.type === "tabs.select") {
              entry.selectedTabID = tab.tabID
              return { result: { tabs: tabs(entry) } }
            }
            if (command.type === "navigate") {
              if (!URL.canParse(command.url) || !resource.policy.approvedOrigins.includes(new URL(command.url).origin))
                fail("BROWSER_NETWORK_DENIED")
              entry.dispatched = true
              await contents.loadURL(command.url)
            } else if (command.type === "back" || command.type === "forward" || command.type === "reload") {
              entry.dispatched = true
              if (command.type === "back") contents.navigationHistory.goBack()
              if (command.type === "forward") contents.navigationHistory.goForward()
              if (command.type === "reload") await contents.reload()
            } else if (command.type === "stop") contents.stop()
            else if (command.type === "tabs.close") {
              if (entry.tabs.size <= 1) fail("BROWSER_SCOPE_DENIED")
              await tab.driver.cleanup()
              tab.detachNetwork()
              tab.window.destroy()
              entry.tabs.delete(tab.tabID)
            } else if (command.type === "frames.list")
              return { result: { tabs: tabs(entry), frames: await tab.driver.frames() } }
            else if (command.type === "snapshot")
              return { result: { tabs: tabs(entry), ...(await tab.driver.snapshot(command)) } }
            else if (command.type === "file.upload" || command.type === "file.download") {
              if (
                !file ||
                !resource.policy.filePolicy?.[command.type === "file.upload" ? "upload" : "download"] ||
                file.pairs.length < 1 ||
                file.pairs.length > 4 ||
                entry.fileTransfer
              )
                fail("BROWSER_SCOPE_DENIED")
              const expected = SharedBrowserProtocol.fileExecution(entry.resource, lease, action)
              const grantIDs = command.type === "file.upload" ? command.grantIDs : [command.grantID]
              if (
                digest([...grantIDs].sort()) !== digest(file.pairs.map((pair) => pair.grant.grantID).sort()) ||
                new Set(file.pairs.map((pair) => pair.artifact.artifactID)).size !== file.pairs.length
              )
                fail("BROWSER_SCOPE_DENIED")
              for (const pair of file.pairs) {
                const grant = pair.grant,
                  artifact = pair.artifact
                const confirmation = entry.fileConfirmations?.get(grant.command.requestID)
                if (
                  grant.bindingHash !== expected.bindingHash ||
                  digest(grant.binding) !== expected.bindingHash ||
                  artifact.bindingHash !== expected.bindingHash ||
                  digest(artifact.binding) !== expected.bindingHash ||
                  artifact.grantID !== grant.grantID ||
                  artifact.grantHash !== digest(grant) ||
                  digest(artifact.manifest) !== digest(grant.preview) ||
                  artifact.actionID !== action.actionID ||
                  artifact.admissionID !== action.admissionID ||
                  artifact.providerReceiptID !== action.providerReceiptID ||
                  artifact.providerAttemptID !== action.providerAttemptID ||
                  artifact.toolCallID !== action.toolCallID ||
                  grant.expiresAt <= Date.now() ||
                  !confirmation ||
                  confirmation.digest !==
                    digest({ lease: leaseIdentity(lease), preview: grant.preview, command: grant.command }) ||
                  digest(await confirmation.value) !== digest(grant.confirmation)
                )
                  fail("BROWSER_SCOPE_DENIED")
                await current(entry, lease, epoch)
              }
              const origins = file.pairs.map((pair) => new URL(pair.grant.preview.targetURL).origin)
              if (!origins.every((origin) => origin === origins[0])) fail("BROWSER_SCOPE_DENIED")
              const check = () => entry.context.run(action, () => current(entry, lease, epoch))
              const transfer = createManagedBrowserFiles({
                action,
                files: file.pairs,
                actions: tab.driver,
                shared: {
                  origin: origins[0]!,
                  download: (url, signal) => entry.network!.download(action, url, signal, check),
                },
                current: check,
                ask: file.ask,
                fail,
              })
              entry.fileTransfer = transfer
              entry.fileAction = action
              try {
                const publications = await transfer.run()
                await check()
                if (!(await transfer.close())) fail("BROWSER_UNKNOWN")
                if (entry.fileTransfer === transfer) {
                  entry.fileTransfer = undefined
                  entry.fileAction = undefined
                }
                tab.driver.invalidate()
                return {
                  result: {
                    tabs: tabs(entry),
                    files: publications.map((value) => ({
                      artifactID: value.artifactID,
                      grantID: value.grantID,
                      direction: value.direction,
                      name: file.pairs.find((pair) => pair.artifact.artifactID === value.artifactID)!.grant.preview
                        .name,
                      bytes: value.bytes,
                      sha256: value.sha256,
                      state: value.outcome,
                      nativeVerified: true as const,
                    })),
                  },
                }
              } catch (error) {
                if (entry.epoch === epoch && entry.resource.state === "agent_owned")
                  beginTakeover(
                    entry.resource,
                    {
                      resourceID: resource.resourceID,
                      requestID: randomUUID(),
                      expectedRevision: entry.resource.revision,
                    },
                    "permission_lost",
                  )
                throw error
              }
            } else if (command.type === "evaluate" || command.type === "program") {
              if (
                !(command.type === "evaluate"
                  ? SharedBrowserScriptPolicy.allowsScript(resource.policy, command)
                  : SharedBrowserScriptPolicy.allowsProgram(resource.policy, command))
              )
                fail("BROWSER_SCOPE_DENIED")
              const driver = tab.driver
              const page = await driver.scriptPage(command)
              currentNow(entry, lease, epoch)
              const compute = createSharedBrowserComputation({
                resourceKey: mainIncarnation + "/" + resource.resourceID,
                command,
                page,
                deadline: action.deadline,
                fail,
                current: async () => {
                  await current(entry, lease, epoch)
                  await driver.scriptPage(command)
                },
                currentNow: () => currentNow(entry, lease, epoch),
              })
              entry.compute = compute
              try {
                const output = await compute.result
                currentNow(entry, lease, epoch)
                if (command.type === "program") {
                  const program = await driver.program(
                    command,
                    resource.policy.programGrants,
                    output.json,
                    action.deadline,
                  )
                  currentNow(entry, lease, epoch)
                  return { result: { tabs: tabs(entry), program, scriptContextEvidence: output.evidence } }
                }
                return {
                  result: { tabs: tabs(entry), scriptResultJSON: output.json, scriptContextEvidence: output.evidence },
                }
              } finally {
                if (entry.compute === compute) entry.compute = undefined
                driver.invalidate()
              }
            } else if (command.type === "screenshot") {
              const image = await contents.capturePage(undefined, { stayHidden: true })
              currentNow(entry, lease, epoch)
              const png = image.toPNG()
              if (png.length < 24 || png.length > BrowserSchema.MAX_PNG_BYTES) fail("BROWSER_OUTPUT_LIMIT")
              const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
              if (!size.width || !size.height || size.width * size.height > BrowserSchema.MAX_PIXELS)
                fail("BROWSER_OUTPUT_LIMIT")
              entry.preview = {
                png: png.toString("base64"),
                observedAt: Date.now(),
                manualEpoch: entry.resource.manualEpoch,
              }
              return {
                result: {
                  tabs: tabs(entry),
                  image: {
                    mime: "image/png" as const,
                    hash: createHash("sha256").update(png).digest("hex"),
                    bytes: png.length,
                    ...size,
                  },
                },
                png: entry.preview.png,
              }
            } else if ("ref" in command && !["file.upload", "file.download"].includes(command.type)) {
              if ((command.type === "click" || command.type === "press") && command.waitForNavigation) {
                const navigation = Promise.withResolvers<void>()
                const loaded = () => navigation.resolve()
                const failed = (_event: Electron.Event, _code: number, _text: string, _url: string, main: boolean) => {
                  if (main) navigation.reject(new SharedBrowserMainError("BROWSER_UNKNOWN"))
                }
                const deadline = setTimeout(
                  () => navigation.reject(new SharedBrowserMainError("BROWSER_UNKNOWN")),
                  Math.max(1, action.deadline - Date.now()),
                )
                contents.once("did-finish-load", loaded)
                contents.on("did-fail-load", failed)
                try {
                  await Promise.all([tab.driver.execute(command), navigation.promise])
                } finally {
                  clearTimeout(deadline)
                  contents.removeListener("did-finish-load", loaded)
                  contents.removeListener("did-fail-load", failed)
                }
              } else await tab.driver.execute(command)
            } else fail("BROWSER_SCOPE_DENIED")
            currentNow(entry, lease, epoch)
            return { result: { tabs: tabs(entry) } }
          } catch (error) {
            if (entry.dispatched) {
              entry.unknownEffects = true
              publish(entry)
              fail("BROWSER_UNKNOWN")
            }
            throw error
          } finally {
            clearTimeout(timer)
            if (entry.action === action) entry.action = undefined
          }
        }),
      )
      entry.chain = operation.then(
        () => undefined,
        () => undefined,
      )
      try {
        return await Promise.race([operation, finished.promise])
      } finally {
        entry.queue--
      }
    },
    close,
  }
}

let manager: ReturnType<typeof createSharedBrowserManager> | undefined
export function sharedBrowserManager() {
  return (manager ??= createSharedBrowserManager({}))
}
