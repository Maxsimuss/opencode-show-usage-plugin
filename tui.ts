import { Plugin } from "@opencode/plugin/tui"
import { ScrollBoxRenderable, TextRenderable, type BaseRenderable } from "@opentui/core"
import { createComponent, createElement, insert, insertNode, setProp } from "@opentui/solid"
import { createEffect, createResource, createSignal, For, Show } from "solid-js"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { promisify } from "node:util"

const exec = promisify(execFile)
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cost: number) => cost > 0 && cost < 0.01 ? "<$0.01" : usd.format(cost)

type Limit = { left?: number; resetAt?: number }
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type Rate = { input: number; output: number; cache_read?: number; cache_write?: number }
type Price = Rate & { tiers?: (Partial<Rate> & { tier: { type: string; size: number } })[] }
type Catalog = Record<string, { models: Record<string, { cost?: Price }> }>
type ModelEstimate = { id: string; providerID: string; cost?: number }
const modelKey = (providerID: string, id: string) => JSON.stringify([providerID, id])
const modelLabel = (providerID: string, id: string, variant?: string) =>
  `${providerID}/${id}${variant ? `#${variant}` : ""}`

function totalEstimate(rows: ModelEstimate[]) {
  const priced = rows.filter((row) => row.cost !== undefined)
  if (!priced.length && rows.length) return "unpriced"
  const total = priced.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  const amount = total > 0 && total < 0.01
    ? (total < 0.00001 ? "<$0.00001" : `$${total.toFixed(5)}`)
    : money(total)
  return priced.length < rows.length ? `${amount}+` : amount
}

function apiCost(price: Price | undefined, tokens: Tokens) {
  if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) return undefined
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const tier = price.tiers?.filter(({ tier }) => tier.type === "context" && context > tier.size)
    .sort((a, b) => b.tier.size - a.tier.size)[0]
  const rate = { ...price, ...tier }
  return (tokens.input * rate.input + (tokens.output + tokens.reasoning) * rate.output
    + tokens.cache.read * (rate.cache_read ?? rate.input)
    + tokens.cache.write * (rate.cache_write ?? rate.input)) / 1_000_000
}

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
  setup({ ui, theme, data, client, location, renderer, keymap, app }) {
    const [codex, setCodex] = createSignal<Limit[]>([{}, {}])
    const [now, setNow] = createSignal(Date.now())
    const sessionID = () => {
      const route = ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const rootID = () => {
      const id = sessionID()
      return id ? data.session.root(id) : undefined
    }
    let catalog: Promise<Catalog> | undefined
    const prices = () => catalog ??= fetch("https://models.dev/api.json", {
      headers: { Accept: "application/json", "User-Agent": "OpenCode-Show-Usage/1.1" },
      signal: AbortSignal.timeout(8000),
    }).then((response) => {
      if (!response.ok) throw new Error("Pricing catalog unavailable")
      return response.json() as Promise<Catalog>
    }).catch((error) => {
      catalog = undefined
      throw error
    })
    const cache = new Map<string, { revision: string; rows: Promise<ModelEstimate[]> }>()
    const costSource = () => {
      const root = rootID()
      if (!root) return false
      const ids = [...new Set([root, ...data.session.family(root)])].sort()
      return JSON.stringify([root, ids.map((id) => [id, JSON.stringify(data.session.get(id)?.tokens ?? null)])])
    }
    const [modelCosts] = createResource(costSource, async (source) => {
      const [root, sessions] = JSON.parse(source) as [string, [string, string][]]
      try {
        const rates = await prices()
        const bySession = await Promise.all(sessions.map(([sessionID, revision]) => {
          const previous = cache.get(sessionID)
          if (previous?.revision === revision) return previous.rows
          const rows = Promise.all((["assistant", "compaction"] as const).map(async (type) => {
            const estimates: ModelEstimate[] = []
            let cursor: string | undefined
            do {
              const page = await client.message.list({ sessionID, type, cursor })
              for (const message of page.data) {
                if (message.type !== "assistant" && (message.type !== "compaction" || message.status !== "completed")) continue
                const { model, tokens } = message
                if (!model || !tokens) continue
                const cost = apiCost(rates[model.providerID]?.models[model.id]?.cost, tokens)
                estimates.push({ id: model.id, providerID: model.providerID, cost })
              }
              cursor = page.cursor.next ?? undefined
            } while (cursor)
            return estimates
          })).then((estimates) => estimates.flat())
          const entry = { revision, rows }
          cache.set(sessionID, entry)
          void rows.catch(() => { if (cache.get(sessionID) === entry) cache.delete(sessionID) })
          return rows
        }))
        const costs = new Map<string, ModelEstimate>()
        for (const rows of bySession) {
          for (const row of rows) {
            const key = modelKey(row.providerID, row.id)
            const previous = costs.get(key)
            costs.set(key, previous
              ? { ...row, cost: row.cost === undefined || previous.cost === undefined ? undefined : previous.cost + row.cost }
              : row)
          }
        }
        return {
          root,
          costs: [...costs.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
          byChild: new Map(sessions.map(([id], index) => [id, totalEstimate(bySession[index])])),
        }
      } catch {
        return { root, costs: undefined }
      }
    })
    const sessionCosts = () => {
      const result = modelCosts()
      return result?.root === rootID() ? result?.costs : undefined
    }
    const selectedCost = () => {
      const model = ui.model.current()
      const costs = sessionCosts()
      if (!model || !costs) return "—"
      const row = costs.find((row) => row.providerID === model.providerID && row.id === model.modelID)
      return row?.cost !== undefined ? money(row.cost) : row ? "unpriced" : money(0)
    }
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
    const text = (content: () => string, color = () => theme.text.muted) => {
      const node = createElement("text")
      createEffect(() => { setProp(node, "fg", color()) })
      insert(node, content)
      return node
    }

    // OpenCode 2.3.2 has no picker slot. Match its native rows without replacing the picker.
    const labels = new Map<BaseRenderable, TextRenderable>()
    const updatePicker = () => {
      for (const [row, label] of labels) if (row.isDestroyed || label.isDestroyed) labels.delete(row)
      const root = rootID()
      if (!root || keymap.mode.current() !== "composer") return
      const children = data.session.list().filter((item) => item.parentID)
      const descendants = (parentID: string): typeof children => children
        .filter((item) => item.parentID === parentID)
        .flatMap((item) => [item, ...descendants(item.id)])
      const agents = descendants(root)
      if (!agents.length) return
      const result = modelCosts()
      const estimates = result?.root === root ? result.byChild : undefined
      const tree = [renderer.root as BaseRenderable]
      while (tree.length) {
        const node = tree.pop()!
        if (node.isDestroyed || !node.visible) continue
        tree.push(...node.getChildren())
        if (!(node instanceof ScrollBoxRenderable) || node.getMaxHeight().value !== 5) continue
        const rows = node.getChildren().map((row) => {
          const items = row.getChildren()
          const title = items[0]?.getChildren()[0]
          const status = items.find((item) => item instanceof TextRenderable && item.plainText === "Running")
          return { row, title, status }
        })
        if (!rows.length || rows.some(({ title }) => !(title instanceof TextRenderable))) continue
        const running = rows.every(({ status }) => !!status)
        const entries = agents.filter((agent) => (data.session.status(agent.id) === "running") === running)
        if (rows.length !== entries.length || rows.some(({ title }, index) => {
          const original = entries[index].title ?? ""
          const name = original.replace(/@\w+ subagent/, "").trim() || original
          return !name || !(title as TextRenderable).plainText.endsWith(`: ${name}`)
        })) continue
        const models = entries.map(({ model }) => model ? modelLabel(model.providerID, model.id, model.variant) : "—")
        const amounts = entries.map(({ id }) => estimates?.get(id) ?? "—")
        const modelWidth = Math.max(...models.map((model) => model.length))
        const priceWidth = Math.max(...amounts.map((amount) => amount.length))
        rows.forEach(({ row, title, status }, index) => {
          const value = `  ${models[index].padEnd(modelWidth)}  ${amounts[index].padStart(priceWidth)}${status ? " · " : ""}`
          const color = (status ?? title) as TextRenderable
          let label = labels.get(row)
          if (!label) {
            label = new TextRenderable(renderer, { content: value, fg: color.fg, wrapMode: "none", flexShrink: 0 })
            if (status) row.insertBefore(label, status)
            else row.add(label)
            labels.set(row, label)
          } else {
            if (label.plainText !== value) label.content = value
            if (!label.fg.equals(color.fg)) label.fg = color.fg
          }
        })
      }
    }
    if (app.version === "2.3.2") renderer.on("frame", updatePicker)

    ui.slot({
      append: "prompt.footer.status",
      render: () => createComponent(Show, {
        get when() { return sessionID() },
        get children() {
          const node = text(() => {
            const cost = `API est. ${selectedCost()}`
            return visible() ? `5h ${status(limits()[0])} · Wk ${status(limits()[1])} · ${cost}` : cost
          })
          setProp(node, "flexShrink", 0)
          return node
        },
      }),
    })
    ui.slot({
      append: "sidebar.content",
      render: () => createComponent(Show, {
        get when() { return visible() },
        get children() {
          const box = createElement("box")
          setProp(box, "flexDirection", "column")
          insertNode(box, text(() => provider() === "opencode-go" ? "opencode-go usage" : "openai · Codex usage", () => theme.text.base))
          insertNode(box, text(() => `5h: ${sidebar(limits()[0])}`))
          insertNode(box, text(() => `Weekly: ${sidebar(limits()[1])}`))
          return box
        },
      }),
    })
    ui.slot({
      append: "sidebar.content",
      render: () => createComponent(Show, {
        get when() { return rootID() },
        get children() {
          const box = createElement("box")
          setProp(box, "flexDirection", "column")
          insertNode(box, text(() => {
            const costs = sessionCosts()
            if (!costs) return "Session API est. —"
            const priced = costs.filter((row) => row.cost !== undefined)
            const total = money(priced.reduce((sum, row) => sum + (row.cost ?? 0), 0))
            return `Session API est. ${priced.length ? total : costs.length ? "—" : total}${priced.length && priced.length < costs.length ? "+" : ""}`
          }, () => theme.text.base))
          const rows = createElement("box")
          setProp(rows, "flexDirection", "column")
          insertNode(box, rows)
          insert(rows, createComponent(For, {
            get each() { return sessionCosts() ?? [] },
            children: (row: ModelEstimate) => text(() => {
              return `${modelLabel(row.providerID, row.id)}: ${row.cost === undefined ? "unpriced" : money(row.cost)}`
            }),
          }))
          return box
        },
      }),
    })
    return () => {
      clearInterval(timer)
      renderer.off("frame", updatePicker)
      for (const label of labels.values()) if (!label.isDestroyed) label.destroy()
    }
  },
})
