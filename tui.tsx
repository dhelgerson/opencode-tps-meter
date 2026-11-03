// OpenCode TUI plugin: a tokens-per-second readout in the prompt footer.
//
// The terminal twin of gui-experimental.cjs. OpenCode loads this through the
// `./tui` entry of this plugin directory (or from a project `.opencode/plugins`
// discovery folder) and runs the default export's `setup` in every TUI. It
// only imports modules the TUI shares with plugin bundles
// (`@opencode/plugin/tui`, `solid-js`, and `@opentui/solid/jsx-runtime`), and
// avoids JSX syntax on purpose, so there is nothing to build.
//
// What it shows, in the status part of the footer under the prompt:
//   - While a model writes: a live count. `session.text.delta` and
//     `session.reasoning.delta` carry every streamed fragment, so the readout
//     counts characters and converts them with a characters-per-token ratio
//     taken from the token counts the server reports. Clock time only counts
//     while characters arrive, so a long tool run does not drag the number
//     down. When the event stream is unavailable, the number falls back to the
//     length of the partial assistant message in the synced store.
//   - Once the turn settles: the exact measure, `(output + reasoning) tokens /
//     streamed seconds` over the turn's model requests, excluding tool time.
//     That is the same measure the desktop badge and the debug bar compute.
//   - A turn is the span since the last user/synthetic/idle boundary, so a
//     steered prompt does not reset the number.
//
// `/tps` (or the command palette) hides and shows the readout. The options
// `enabled` and `live` match the desktop plugin's.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"

const CHARS_PER_TOKEN = 4
const MIN_LIVE_CHARS = 240
const MIN_LIVE_MS = 600
const ACTIVE_GAP = 1500
const POLL_MS = 400
const WATCH_MS = 1500
const LIVE_TYPES = ["session.text.delta", "session.reasoning.delta"]
const TURN_TYPES = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.ended",
  "session.step.failed",
]

// An assistant message that settles a turn: anything but a step that only
// handed the loop over to tools.
function isTerminal(message) {
  if (!message || message.type !== "assistant") return false
  if (message.retry || message.error) return true
  return !!message.finish && message.finish !== "tool-calls" && message.finish !== "unknown"
}

function hasIdle(messages) {
  for (const message of messages) if (message.type === "idle") return true
  return false
}

// Index of the boundary that starts the turn holding `end`.
function turnStart(messages, end, legacy) {
  let found = -1
  for (let i = end - 1; i >= 0; i--) {
    const type = messages[i].type
    if (type === "idle") return -1
    if (type === "user" || type === "synthetic") {
      if (legacy) return i
      found = i
    }
  }
  return found
}

function outTokens(message) {
  const tokens = message.tokens
  if (!tokens) return 0
  return (tokens.output || 0) + (tokens.reasoning || 0)
}

// The exact rate for the turn of `index`, with the characters counted live for
// it, so the ratio used while streaming is a real one.
function turnMeasure(messages, index, characters) {
  const start = turnStart(messages, index + 1, !hasIdle(messages))
  let tokens = 0
  let streamed = 0
  let seen = 0
  for (let i = start + 1; i <= index; i++) {
    const message = messages[i]
    if (message.type !== "assistant") continue
    seen++
    tokens += outTokens(message)
    const time = message.time
    if (time && time.streamed !== undefined && time.created !== undefined) streamed += Math.max(0, time.streamed - time.created)
  }
  if (seen === 0 || tokens <= 0 || streamed <= 0) return
  return {
    tokens: tokens,
    seconds: streamed / 1000,
    rate: tokens / (streamed / 1000),
    ratio: characters > 200 ? characters / tokens : undefined,
  }
}

function latestAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].type === "assistant") return i
  return -1
}

// The index of the assistant message the model is still writing, if any.
function streamingIndex(messages) {
  const index = latestAssistant(messages)
  if (index === -1 || isTerminal(messages[index])) return -1
  return index
}

function contentLength(message) {
  let total = 0
  for (const block of message.content || []) {
    if (block.type === "text" || block.type === "reasoning") total += (block.text || "").length
  }
  return total
}

function format(value) {
  if (!(value > 0) || !Number.isFinite(value)) return ""
  return (value >= 100 ? String(Math.round(value)) : value.toFixed(1)) + " t/s"
}

function ratio(row) {
  return row.measured && row.measured.ratio ? row.measured.ratio : CHARS_PER_TOKEN
}

// Streaming seconds so far: only the time between arriving characters counts,
// so waiting for tools is not charged to the model.
function liveSeconds(row) {
  if (row.lastChar === undefined) return 0.3
  const now = Date.now()
  const open = now - row.lastChar < ACTIVE_GAP ? now - row.lastChar : 0
  return Math.max(0.3, (row.active + open) / 1000)
}

export default Plugin.define({
  id: "tps-meter.tui",
  setup(ctx) {
    const options = ctx.options || {}
    const showLive = options.live !== false
    const [shown, setShown] = createSignal(options.enabled !== false)
    const rows = new Map()

    function rowFor(sessionID) {
      const existing = rows.get(sessionID)
      if (existing) return existing
      const row = {
        sessionID: sessionID,
        rate: createSignal(undefined),
        chars: 0,
        deltaChars: 0,
        turnChars: 0,
        active: 0,
        lastChar: undefined,
        live: false,
        measured: undefined,
        settled: -1,
        prompt: -1,
        poll: undefined,
      }
      rows.set(sessionID, row)
      return row
    }

    function reset(row) {
      row.chars = 0
      row.deltaChars = 0
      row.turnChars = 0
      row.active = 0
      row.lastChar = undefined
      row.live = false
    }

    function messagesOf(sessionID) {
      try {
        return ctx.data.session.message.list(sessionID)
      } catch (error) {
        return undefined
      }
    }

    // Tick while a model writes, so the estimate moves on its own.
    function poll(row, on) {
      if (on && row.poll === undefined) {
        row.poll = setInterval(() => read(row), POLL_MS)
      }
      if (!on && row.poll !== undefined) {
        clearInterval(row.poll)
        row.poll = undefined
      }
    }

    // Take in a character count for the message being written, and spend
    // clock time only while that count grows.
    function count(row, chars) {
      if (chars <= row.chars) return
      const now = Date.now()
      if (row.lastChar !== undefined) {
        const gap = now - row.lastChar
        if (gap < ACTIVE_GAP) row.active += gap
      }
      row.lastChar = now
      row.chars = chars
      row.turnChars = Math.max(row.turnChars, chars)
    }

    function setRate(row, value) {
      row.rate[1](value)
    }

    // Recompute one session's readout from the TUI's synced messages.
    function read(row) {
      const messages = messagesOf(row.sessionID)
      if (!messages || messages.length === 0) return
      let settled = -1
      let prompt = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (settled === -1 && isTerminal(messages[i])) settled = i
        if (prompt === -1 && (messages[i].type === "user" || messages[i].type === "synthetic")) prompt = i
        if (settled !== -1 && prompt !== -1) break
      }
      // A new prompt started: count this turn fresh.
      if (prompt > row.prompt) {
        row.prompt = prompt
        reset(row)
      }

      const running = streamingIndex(messages)
      if (running !== -1) {
        count(row, Math.max(contentLength(messages[running]), row.deltaChars))
        row.live = true
        const known = row.measured ? row.measured.rate : undefined
        // The first fragment tells nothing yet, and one large synced chunk
        // divided by a sliver of clock would be a wild number: wait until the
        // turn has written a little and the clock has actually been watched.
        setRate(row, row.chars < MIN_LIVE_CHARS || row.active < MIN_LIVE_MS ? known : row.chars / ratio(row) / liveSeconds(row))
        poll(row, true)
        return
      }

      poll(row, false)
      if (settled !== -1 && settled !== row.settled) {
        row.settled = settled
        row.measured = turnMeasure(messages, settled, row.turnChars)
        setRate(row, row.measured ? row.measured.rate : undefined)
        reset(row)
        return
      }
      if (row.live && row.chars > 0) {
        // Streaming stopped just before the turn settled: keep the best number
        // available instead of falling back to the previous turn.
        setRate(row, row.chars / ratio(row) / liveSeconds(row))
        row.live = false
      }
    }

    // Live character counts. `session.text.delta` and `session.reasoning.delta`
    // are ephemeral events; the plugin adds one filtered subscription to the
    // server's event stream and counts fragments per session. Deltas only
    // carry the newest fragment, so they are summed on their own and `read`
    // keeps whichever count is larger: this stream's sum or the part the TUI
    // has already synced. `read` then runs on the poll, not per fragment:
    // rescanning the synced messages for every arriving character grows
    // quadratically with the response.
    let stopLive
    if (showLive && ctx.client && ctx.client.event && typeof ctx.client.event.subscribe === "function") {
      try {
        const controller = new AbortController()
        let stopped = false
        const source = ctx.client.event.subscribe({ types: LIVE_TYPES, signal: controller.signal })
        stopLive = () => {
          stopped = true
          try {
            controller.abort()
          } catch (error) {
            // Aborting a stream that already ended is not worth reporting.
          }
        }
        const consume = async (iterable) => {
          try {
            for await (const event of iterable) {
              if (stopped) break
              if (!event || event.type === "server.connected") continue
              const data = event.data
              if (!data || typeof data.sessionID !== "string" || typeof data.delta !== "string") continue
              const row = rowFor(data.sessionID)
              row.deltaChars += data.delta.length
              row.live = true
            }
          } catch (error) {
            // The stream ends when its server restarts; the next TUI start
            // opens a new one.
          }
        }
        // Older clients hand back a promise of the stream, newer ones the stream.
        const started = source && typeof source.then === "function" ? source.then(consume) : consume(source)
        if (started && typeof started.catch === "function") started.catch(() => {})
      } catch (error) {
        stopLive = undefined
      }
    }

    // Settle the exact number on the events that end a step or a turn.
    let stopTurns
    if (ctx.data && typeof ctx.data.listen === "function") {
      try {
        stopTurns = ctx.data.listen((event) => {
          const details = event && event.details
          const type = details && details.type
          if (!type || TURN_TYPES.indexOf(type) === -1) return
          const data = details.data
          if (!data || typeof data.sessionID !== "string") return
          const row = rows.get(data.sessionID)
          if (row) read(row)
        })
      } catch (error) {
        stopTurns = undefined
      }
    }

    // Cheap safety net: recompute even when an event is missed, and start the
    // fast poll for a session that just began streaming.
    const watchdog = setInterval(() => {
      for (const row of rows.values()) read(row)
    }, WATCH_MS)

    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "tps-meter.toggle",
          title: shown() ? "Hide tokens per second" : "Show tokens per second",
          group: "View",
          keywords: "tps tokens per second speed throughput",
          palette: true,
          slash: { name: "tps" },
          run: () => setShown((value) => !value),
        },
      ],
      bindings: [],
    }))

    ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input && input.sessionID
        if (sessionID) rowFor(sessionID)
        const label = () => {
          if (!shown() || !sessionID) return ""
          const row = rows.get(sessionID)
          if (!row) return ""
          return format(row.rate[0]())
        }
        // Deliberately no JSX: installed package plugins live under
        // node_modules, where the TUI's Solid JSX transform does not apply and
        // the fallback transpiler would emit `react` imports. Calling the
        // runtime's own jsx() keeps this file loadable everywhere, with only
        // specifiers the plugin runtime maps.
        return jsx("text", {
          fg: ctx.theme.text.muted,
          get children() {
            return label()
          },
        })
      },
    })

    return () => {
      clearInterval(watchdog)
      if (stopLive) stopLive()
      if (typeof stopTurns === "function") stopTurns()
      for (const row of rows.values()) if (row.poll !== undefined) clearInterval(row.poll)
      rows.clear()
    }
  },
})
