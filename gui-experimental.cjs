"use strict"
// OpenCode Desktop GUI plugin: a tokens-per-second readout in every session header.
//
// This file IS the bundle. OpenCode Desktop reads it through the
// `./gui-experimental` entry of this plugin directory, evaluates it as CommonJS,
// and runs the default export's `setup` in every window. It only requires
// modules the app shares with plugin bundles (`@opencode/plugin/gui` and
// `solid-js`), so there is nothing to build.
//
// What it shows:
//   - While a model writes: a live count. `session.text.delta` and
//     `session.reasoning.delta` carry every streamed fragment, so the badge
//     counts characters and converts them with a characters-per-token ratio
//     taken from the token counts the server reports. Clock time only counts
//     while characters arrive, so a long tool run does not drag the number
//     down. Without the event stream, the characters come from the synced
//     lengths of the turn's messages instead.
//   - Once the turn settles: the exact measure, `(output + reasoning) tokens /
//     streamed seconds` over the turn's model requests, excluding tool time.
//     That is the same measure the app's own debug bar computes.
//   - A turn is the span since the last user/synthetic/idle boundary, so a
//     steered prompt does not reset the number.

const { Plugin, Slot, Command } = require("@opencode/plugin/gui")
const { createSignal, createEffect, onCleanup } = require("solid-js")

const CHARS_PER_TOKEN = 4
const MIN_LIVE_CHARS = 240
const MIN_LIVE_MS = 600
const ACTIVE_GAP = 1500
const POLL_MS = 400
const WATCH_MS = 1500
const LIVE_RETRY_MS = 5000
const MAX_LIVE_RATE = 1000
const RATIO_MIN = 1.2
const RATIO_MAX = 8
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

// The learned characters-per-token ratio, bounded: code sits near 2 and prose
// near 4, so a value far outside that band is a counting error rather than the
// model's doing, and the default ratio stays in charge instead.
function clampedRatio(value) {
  if (!(value >= RATIO_MIN) || value > RATIO_MAX) return
  return value
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
    ratio: characters > 200 ? clampedRatio(characters / tokens) : undefined,
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

// Everything the turn has written, whether or not the delta stream is alive:
// the finished assistant messages after the prompt boundary, plus the partial
// one still being written. A tool-heavy turn streams many short messages, and
// counting only the running one made the learned ratio far too small, which
// multiplied every later live estimate.
function turnLength(messages, start, index) {
  let total = 0
  for (let i = start + 1; i <= index; i++) {
    const message = messages[i]
    if (message.type === "assistant") total += contentLength(message)
  }
  return total
}

function sessionMessages(session) {
  const data = session.server && session.server.data
  if (!data || !data.session || !data.session.message || typeof data.session.message.list !== "function") return
  try {
    return data.session.message.list(session.id)
  } catch (error) {
    return
  }
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

// The live estimate, kept under a plausibility ceiling. Characters arrive in
// bursts and one bad ratio could otherwise multiply a whole session's numbers;
// no model streams anywhere near this fast.
function liveRate(row) {
  return Math.min(row.chars / ratio(row) / liveSeconds(row), MAX_LIVE_RATE)
}

function tip(row) {
  const measured = row.measured
    ? "Measured " + row.measured.tokens + " output tokens in " + row.measured.seconds.toFixed(1) + "s."
    : "Nothing measured in this turn yet."
  if (row.live) {
    return "Streaming ~" + Math.round(row.chars / ratio(row)) + " tokens in " + liveSeconds(row).toFixed(1) + "s. " + measured
  }
  if (row.measured) return "Output and reasoning tokens per second across the latest turn's model requests, excluding tool time. " + measured
  return "Waiting for the first model response in this session."
}

exports.default = Plugin.define({
  i18n: {
    en: {
      "command.enable": "Show tokens per second",
      "command.disable": "Hide tokens per second",
    },
  },
  setup(ctx) {
    const options = ctx.options || {}
    const showLive = options.live !== false
    const [shown, setShown] = createSignal(options.enabled !== false)
    const [tick, setTick] = createSignal(0)
    const rows = new Map()

    function bump() {
      setTick((value) => value + 1)
    }

    function rowFor(session) {
      const existing = rows.get(session.key)
      if (existing) {
        existing.session = session
        return existing
      }
      const row = {
        session: session,
        chars: 0,
        deltaChars: 0,
        turnChars: 0,
        active: 0,
        lastChar: undefined,
        live: false,
        measured: undefined,
        rate: undefined,
        settled: -1,
        prompt: -1,
        liveRetryAt: 0,
        stopLive: undefined,
        stopTurns: [],
        timer: undefined,
      }
      rows.set(session.key, row)
      return row
    }

    function stop(row) {
      if (row.stopLive) row.stopLive()
      row.stopLive = undefined
      for (const off of row.stopTurns) off()
      row.stopTurns = []
      if (row.timer !== undefined) clearInterval(row.timer)
      row.timer = undefined
      rows.delete(row.session.key)
    }

    function reset(row) {
      row.chars = 0
      row.deltaChars = 0
      row.turnChars = 0
      row.active = 0
      row.lastChar = undefined
      row.live = false
    }

    // Tick while a model writes, so the estimate moves on its own.
    function poll(row, on) {
      if (on && row.timer === undefined) {
        row.timer = setInterval(() => {
          read(row)
          bump()
        }, POLL_MS)
      }
      if (!on && row.timer !== undefined) {
        clearInterval(row.timer)
        row.timer = undefined
      }
    }

    // Take in a character count for the turn being written, and spend
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

    // Recompute one session's readout from the app's synced messages.
    function read(row) {
      const messages = sessionMessages(row.session)
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
        count(row, Math.max(turnLength(messages, prompt, running), row.deltaChars))
        row.live = true
        const known = row.measured ? row.measured.rate : undefined
        // The first fragment tells nothing yet, and one large synced chunk
        // divided by a sliver of clock would be a wild number: wait until the
        // turn has written a little and the clock has actually been watched.
        row.rate = row.chars < MIN_LIVE_CHARS || row.active < MIN_LIVE_MS ? known : liveRate(row)
        poll(row, true)
        return
      }

      poll(row, false)
      if (settled !== -1 && settled !== row.settled) {
        row.settled = settled
        row.measured = turnMeasure(messages, settled, row.turnChars)
        row.rate = row.measured ? row.measured.rate : undefined
        reset(row)
        return
      }
      if (row.live && row.chars > 0) {
        // Streaming stopped just before the turn settled: keep the best number
        // available instead of falling back to the previous turn.
        row.rate = liveRate(row)
        row.live = false
      }
    }

    // Live character counts. `session.text.delta` / `session.reasoning.delta`
    // are ephemeral events; the app shares one event stream per server, and
    // `subscribe` filters it in place. Pass the signal inside the options
    // object: the promise client's `subscribe` takes one argument, and the
    // signal is what releases this subscriber when the session closes.
    // A stream that fails or ends on its own is reopened by the watchdog, so a
    // server restart does not leave the badge on the fallback for good.
    function openLive(row, session) {
      const client = session.server && session.server.client
      if (!showLive || row.stopLive || Date.now() < row.liveRetryAt) return
      if (!client || !client.event || typeof client.event.subscribe !== "function") return
      row.liveRetryAt = Date.now() + LIVE_RETRY_MS
      const controller = new AbortController()
      let stopped = false
      let source
      const settle = () => {
        if (!stopped) row.stopLive = undefined
      }
      try {
        source = client.event.subscribe({ types: LIVE_TYPES, signal: controller.signal })
      } catch (error) {
        return
      }
      row.stopLive = () => {
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
            if (!event.data || event.data.sessionID !== session.id) continue
            if (typeof event.data.delta !== "string") continue
            // Deltas only carry the newest fragment, so they are summed on
            // their own and `read` keeps whichever count is larger: this
            // stream's sum or the turn length the app has already synced.
            // `read` then runs on the poll, not per fragment: rescanning the
            // synced messages for every arriving character grows quadratically
            // with the response and can outrun the stream's event capacity.
            row.deltaChars += event.data.delta.length
            row.live = true
            bump()
          }
        } catch (error) {
          // The stream ends when its server restarts; the watchdog opens a
          // new one while the session stays open.
        }
        settle()
      }
      // Older clients hand back a promise of the stream, newer ones the stream.
      const started = source && typeof source.then === "function" ? source.then(consume) : consume(source)
      if (started && typeof started.catch === "function") started.catch(settle)
    }

    function watch(row, session) {
      const data = session.server && session.server.data
      if (!data || typeof data.on !== "function") return
      for (const type of TURN_TYPES) {
        const off = data.on(type, (event) => {
          if (!event || !event.data || event.data.sessionID !== session.id) return
          read(row)
          bump()
        })
        if (typeof off === "function") row.stopTurns.push(off)
      }
    }

    // One subscription set per session the app has open, so a session streaming
    // in a background tab keeps its number.
    createEffect(() => {
      const open = new Set()
      for (const session of ctx.sessions.list()) {
        if (session.pending) continue
        const row = rowFor(session)
        open.add(session.key)
        if (row.stopTurns.length === 0) watch(row, session)
        openLive(row, session)
        read(row)
      }
      for (const [key, row] of rows) if (!open.has(key)) stop(row)
      bump()
    })

    // Cheap safety net: recompute even when an event is missed, and reopen a
    // dead event stream.
    const watchdog = setInterval(() => {
      for (const row of rows.values()) {
        openLive(row, row.session)
        read(row)
      }
      bump()
    }, WATCH_MS)

    ctx.add(Command, () => ({
      id: "toggle",
      title: shown() ? ctx.t("command.disable") : ctx.t("command.enable"),
      group: "View",
      keywords: "tps tokens per second speed throughput",
      run: () => setShown((value) => !value),
    }))

    ctx.add(Slot, {
      at: "session.header",
      order: 50,
      render: (input) => {
        const row = rows.get(input.session.key) || rowFor(input.session)
        const node = document.createElement("span")
        node.style.fontSize = "11px"
        node.style.lineHeight = "1"
        node.style.fontWeight = "600"
        node.style.letterSpacing = "0.01em"
        node.style.opacity = "0.65"
        node.style.fontVariantNumeric = "tabular-nums"
        node.style.whiteSpace = "nowrap"
        node.style.padding = "0 2px"
        createEffect(() => {
          tick()
          if (shown() && row.live) read(row)
          node.textContent = shown() ? format(row.rate) : ""
          node.title = tip(row)
        })
        onCleanup(() => {
          // The header can unmount while the session stays open; the row's
          // subscriptions follow the session list, not this node.
          if (row.timer !== undefined && !row.live) poll(row, false)
        })
        return node
      },
    })

    return () => {
      clearInterval(watchdog)
      for (const row of rows.values()) stop(row)
      rows.clear()
    }
  },
})
