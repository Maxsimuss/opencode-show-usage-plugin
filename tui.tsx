import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { promisify } from "node:util"

const exec = promisify(execFile)

type Limit = { left?: number; resetAt?: number }

function remaining(used?: number) {
  return typeof used === "number" && Number.isFinite(used)
    ? Math.min(100, Math.max(0, 100 - used)) : undefined
}

function percent(left?: number) {
  if (left === undefined) return "—"
  return left > 0 && left < 0.1 ? "<0.1%" : `${Number(left.toFixed(1))}%`
}

function countdown(resetAt: number | undefined, now: number) {
  if (resetAt === undefined) return "—"
  const minutes = Math.ceil((resetAt - now) / 60_000)
  if (minutes <= 0) return "now"
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes}m`
}

export default Plugin.define({
  id: "codex-usage",
  setup({ ui, theme, data, location }) {
    const [codex, setCodex] = createSignal<Limit[]>([{}, {}])
    const [now, setNow] = createSignal(Date.now())
    const provider = () => ui.router.current().type === "session" ? ui.model.current()?.providerID : undefined
    const visible = () => provider() === "openai" || provider() === "opencode-go"
    const goLocation = () => {
      const route = ui.router.current()
      return (route.type === "session" ? data.session.get(route.sessionID)?.location : undefined)
        ?? location ?? data.location.default()
    }
    const limits = (): Limit[] => {
      if (provider() !== "opencode-go") return codex()
      const go = data.location.usage.limits(goLocation())?.go
      return [go?.rolling, go?.weekly].map((window) => ({
        left: window?.limited ? 0 : remaining(window?.percent),
        resetAt: window?.resetsAt ?? undefined,
      }))
    }
    const refresh = async () => {
      const { stdout } = await exec("opencode", ["auth", "export", "openai"], {
        cwd: homedir(),
        timeout: 5000,
      })
      const auth = JSON.parse(stdout).find((entry) => entry.active)?.value
      if (auth?.type !== "oauth" || !auth.access) return

      const headers: Record<string, string> = { Authorization: `Bearer ${auth.access}`, Accept: "application/json" }
      let account = auth.metadata?.account
      if (!account) {
        try {
          const claims = JSON.parse(Buffer.from(auth.access.split(".")[1], "base64url").toString("utf8"))
          account = claims.chatgpt_account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id
        } catch {}
      }
      if (typeof account === "string") headers["ChatGPT-Account-Id"] = account
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) return
      const { rate_limit: limit } = await response.json()
      const windows = [limit?.primary_window, limit?.secondary_window]
      const receivedAt = Date.now()
      setNow(receivedAt)
      setCodex([18000, 604800].map((seconds) => {
        const window = windows.find((window) => window?.limit_window_seconds === seconds)
        return {
          left: remaining(window?.used_percent),
          resetAt: window?.reset_at > 0 ? window.reset_at * 1000
            : Number.isFinite(window?.reset_after_seconds) ? receivedAt + window.reset_after_seconds * 1000 : undefined,
        }
      }))
    }
    let lastCheck = 0
    let lastGoCheck = 0
    let lastGoLocation = ""
    const update = () => {
      const time = Date.now()
      if (provider() === "opencode-go") {
        const loc = goLocation()
        const key = JSON.stringify([loc.directory, loc.workspaceID])
        if (key === lastGoLocation && time - lastGoCheck < 5 * 60_000) return
        lastGoLocation = key
        lastGoCheck = time
        data.location.usage.invalidate(loc)
        void data.location.usage.sync(loc).catch(() => {})
        return
      }
      if (provider() !== "openai" || time - lastCheck < 5 * 60_000) return
      lastCheck = time
      void refresh().catch(() => {})
    }
    createEffect(update)
    const timer = setInterval(() => {
      setNow(Date.now())
      update()
    }, 15_000)
    const reset = (limit: Limit) => countdown(limit.resetAt, now())
    const status = (limit: Limit) => limit.left === 0 ? reset(limit) : percent(limit.left)
    const sidebar = (limit: Limit) => {
      const time = reset(limit)
      return `${percent(limit.left)} · ${time === "—" ? "reset unknown" : time === "now" ? "reset due" : `resets in ${time}`}`
    }

    ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={visible()}>
          <text fg={theme.text.muted} flexShrink={0}>
            {`5h ${status(limits()[0])} · Wk ${status(limits()[1])}`}
          </text>
        </Show>
      ),
    })
    ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={visible()}>
          <box flexDirection="column">
            <text fg={theme.text.base}><b>{provider() === "opencode-go" ? "OpenCode Go usage" : "Codex usage"}</b></text>
            <text fg={theme.text.muted}>{`5h: ${sidebar(limits()[0])}`}</text>
            <text fg={theme.text.muted}>{`Weekly: ${sidebar(limits()[1])}`}</text>
          </box>
        </Show>
      ),
    })
    return () => clearInterval(timer)
  },
})
