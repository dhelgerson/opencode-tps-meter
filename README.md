# opencode-tps-meter

A tokens-per-second readout for OpenCode Desktop **and the terminal**. Desktop
adds a small badge to every session header — `142 t/s` while the model writes,
and the exact rate once the turn settles; hover it for the token count and
seconds behind the number. The TUI shows the same number in the status part of
the prompt footer, next to the path and cost.

Two self-contained files (one per surface), no build step, no dependencies.

## Install

Requires OpenCode 2.x. Ask an agent or yourself to run one command:

```sh
opencode plugin add github:dhelgerson/opencode-tps-meter
```

That installs it globally and registers it in the global config. The desktop
app reads plugins **only** from the global `opencode.json(c)` — never from a
project config — so if you configure it by hand instead, edit
`~/.config/opencode/opencode.json` and *merge into* the existing JSON object:
add the entry to its `plugins` array (create the array if absent) and keep
every other key the file already has. Do not replace the file with this
snippet:

```jsonc
// ~/.config/opencode/opencode.json — merge, don't overwrite
{
  "plugins": ["github:dhelgerson/opencode-tps-meter"],
}
```

The change is picked up as the config is watched; otherwise restart OpenCode
Desktop. The CLI needs no extra step: it loads the plugin's TUI part from the
same `plugins` entry. To run the TUI half alone — or keep it active when the
CLI connects to a remote server — list it under `plugins` in
`~/.config/opencode/cli.json` instead.

**Verify:** send any prompt — the session header (Desktop) or the prompt
footer (TUI) should show `… t/s` while the model writes. If it does not, open
**Settings ▸ Extensions ▸ Plugins** (with
the app's own server selected): `opencode-tps-meter` must be listed and
enabled; **Reload** re-reads it after an edit or a failure. A row saying
"Failed" or "Not loaded" means the bundle or the id has a problem.

For a local copy instead of a repository, point the same entry at the folder —
a directory holding `gui-experimental.cjs` and `tui.tsx` beside this
`package.json` is a complete package:

```jsonc
{ "plugins": ["/path/to/opencode-tps-meter"] }
```

Editing a local plugin reloads its GUI in place. An installed package changes
only when its version does, after `opencode plugin update` (or an app restart):
every release needs a new `version` in `package.json`. Branches, tags, and
commit hashes pin via a `#ref` suffix — `github:...#v1.0.0` stays frozen until
the entry changes, `#main` tracks the branch.

## What the number means

| State | Number |
| --- | --- |
| Model is writing | Live estimate: streamed characters ÷ a characters-per-token ratio, over the time characters actually arrived |
| Turn settled | Exact: `(output + reasoning) tokens ÷ streamed seconds` across the turn's model requests, excluding tool time |
| Nothing yet | Blank, until the first response in the session |

The exact measure is the same one OpenCode's own debug bar computes, so the two
agree. Two details worth knowing:

- **Tool time is not charged to the model.** While a command or file read runs,
  the clock pauses, so the live number does not decay into nonsense.
- **A turn is the span since the last prompt boundary**, so steering a running
  turn with an extra message does not reset the count.

The live number is an estimate because the server reports token counts only when a
step ends, not per character. The ratio between characters and tokens is learned
per session from the counts of earlier turns (code-heavy sessions sit near 2
characters per token, prose near 4), which is why the first turn of a session is
rougher than the ones after it.

## Options

Add these to the plugin's entry in the config to change the defaults:

```jsonc
{
  "package": "github:dhelgerson/opencode-tps-meter",
  "options": { "enabled": true, "live": true },
}
```

- `enabled` — start with the badge hidden. The command palette's
  **Hide tokens per second** / **Show tokens per second** toggles it either way;
  in the TUI, `/tps` does the same.
- `live` — `false` shows only the settled number, and skips the extra event
  subscription the live count needs.

## How it works

- `session.text.delta` and `session.reasoning.delta` are ephemeral events that
  carry each streamed fragment. The desktop app keeps one shared event stream per
  server; the plugin adds a filtered subscriber to it per open session with
  `session.server.client.event.subscribe({ types, signal })`, and closes the
  subscriber with the signal when the session's tab closes. The TUI keeps one
  filtered subscription with the same call on `context.client` and counts
  fragments per session inside it.
- Message data comes from the app's own synced store,
  `session.server.data.session.message.list(id)`, so the settled number needs no
  extra requests.
- The badge is a `Slot` at `session.header`, rendered as a plain DOM node: plugin
  bundles are CommonJS with a fixed set of shared modules, so there is no JSX and
  no component framework beyond `solid-js` signals.
- The TUI readout is a `prompt.footer.status` slot — a text renderable in the
  theme's muted color, built with the runtime's own `jsx()` — plus a `/tps`
  command. No JSX syntax in the source on purpose: installed packages load
  from under `node_modules`, where the TUI's Solid JSX transform does not
  apply. The measurement code is the same pure functions in both files, kept
  duplicated so each file stays loadable on its own with no build step. In the
  terminal the number has no hover tooltip, and if the plugin's event
  subscription is unavailable the live count degrades gracefully to the synced
  lengths of the turn's messages. A learned ratio far outside 1.2–8 characters
  per token is treated as a counting error and ignored, and the live estimate
  is capped at a plausibility ceiling.

## Zero-effort alternative

OpenCode Desktop already ships a turn-average TPS readout: the command palette's
**Toggle debug bar**. It is not live, and it takes over a strip at the bottom of
the window, which is why this badge exists. The TUI's debug mode likewise prints
the per-turn average (`… 2.3s · 136.6 tok/s`) under each response.
