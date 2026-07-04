import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { Dialog, DialogFooter } from "@deepagent-code/ui/v2/dialog-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { type Component, Show, createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useGateway } from "@/context/gateway"
import { ServerConnection, useServer } from "@/context/server"
import { GatewayError, normalizeGatewayUrl, workspaceBaseUrl } from "@/utils/gateway-client"
import "./settings-v2.css"

// Connect to a DeepAgent Server Edition gateway: enter the gateway URL and
// credentials, authenticate (JWT), ensure the user's workspace container is
// running, then register the connection and switch to it.
export const DialogConnectServer: Component = () => {
  const dialog = useDialog()
  const gateway = useGateway()
  const server = useServer()
  const navigate = useNavigate()

  const [gatewayUrl, setGatewayUrl] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal("")
  const [progress, setProgress] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    if (busy()) return
    setError("")
    const normalized = normalizeGatewayUrl(gatewayUrl())
    if (!normalized) {
      setError("Enter a valid gateway URL")
      return
    }
    if (!email().trim() || !password()) {
      setError("Email and password are required")
      return
    }

    setBusy(true)
    try {
      // A provisional connection carrying just the gateway URL — used to key the
      // gateway session while we authenticate.
      const provisional: ServerConnection.Server = {
        type: "server",
        gatewayUrl: normalized,
        http: { url: workspaceBaseUrl(normalized) },
      }

      setProgress("Signing in…")
      const result = await gateway.login(provisional, email().trim(), password())

      setProgress("Starting workspace…")
      await gateway.ensureContainer(provisional, {
        onStatus: (c) => setProgress(`Workspace ${c.status}…`),
      })

      const conn: ServerConnection.Server = {
        ...provisional,
        email: result.user.email,
        displayName: result.user.displayName || result.user.email,
        http: { url: workspaceBaseUrl(normalized), bearer: gateway.token(provisional) ?? undefined },
      }
      server.addServerConnection(conn)
      dialog.close()
      navigate("/")
    } catch (err) {
      const message =
        err instanceof GatewayError
          ? err.status === 401
            ? "Invalid email or password"
            : err.message
          : err instanceof Error
            ? err.message
            : String(err)
      setError(message)
    } finally {
      setBusy(false)
      setProgress("")
    }
  }

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <Dialog title="Connect to Server" fit class="settings-v2-server-dialog">
      <div class="flex w-full min-w-0 flex-1 flex-col px-4">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">Gateway URL</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={gatewayUrl()}
              placeholder="https://gateway.example.com"
              invalid={!!error()}
              disabled={busy()}
              autofocus
              onInput={(event) => setGatewayUrl(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">Email</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={email()}
              placeholder="you@example.com"
              disabled={busy()}
              onInput={(event) => setEmail(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">Password</label>
            <TextInputV2
              type="password"
              appearance="large"
              class="!w-full self-stretch"
              value={password()}
              placeholder="••••••••"
              disabled={busy()}
              onInput={(event) => setPassword(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
          </div>
          <Show when={error()}>
            <span class="settings-v2-server-dialog-error">{error()}</span>
          </Show>
          <Show when={busy() && progress()}>
            <span class="text-sm text-muted-foreground">{progress()}</span>
          </Show>
        </div>
      </div>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          Cancel
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={busy()} onClick={submit}>
          {busy() ? "Connecting…" : "Connect"}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
