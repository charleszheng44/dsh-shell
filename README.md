<div align="center">

# dsh-shell

**Your DeepSeek Harness session, without leaving the terminal.**

[![CI](https://github.com/charleszheng44/dsh-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/charleszheng44/dsh-shell/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/charleszheng44/dsh-shell/branch/main/graph/badge.svg)](https://codecov.io/gh/charleszheng44/dsh-shell)
[![License: MIT](https://img.shields.io/badge/license-MIT-6b8cae.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

A small, keyboard-first terminal client that attaches to an already-running
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host. The
Web UI and `dsh-shell` can open the same session, see the same durable history,
and follow the same live agent turn.

[Why dsh-shell?](#why-dsh-shell) · [Quick start](#quick-start) ·
[Keyboard guide](#keyboard-guide) · [dsh-TUI comparison](#dsh-shell-or-dsh-tui)

</div>

## Why dsh-shell?

DeepSeek Harness already has the hard parts: agents, tools, workspaces,
sessions, persistence, queues, approvals, and a capable Web UI. Rebuilding
those inside another terminal application would create a second owner for the
same state.

`dsh-shell` takes a smaller approach. It is a remote view and input surface for
the DSH host you already run:

- start work in the Web UI and continue from a terminal;
- watch one live session from both clients at once;
- keep API keys, execution, policy, and session storage inside DSH;
- get a focused terminal workflow without replacing the Web UI.

```text
                             same DSH session ID

                       ┌─────────────────────────┐
                       │        DSH host         │
                       │ agents · tools · state  │
                       └────────────┬────────────┘
                                    │ HTTP + WebSocket
                             ┌──────┴──────┐
                             │             │
                         Web UI       dsh-shell
```

The DSH host remains the single source of truth. `dsh-shell` never opens the
session database and never interprets subprocess output as a conversation
protocol.

## What it can do

- Browse DSH projects and sessions, or create new ones.
- Replay finalized history and stream live Markdown responses.
- Render reasoning, tool calls, tool results, token usage, and context pressure.
- Send prompts while idle or queue follow-ups during a running turn.
- Edit or steer the last queued message.
- Answer agent questions and allow or reject tool approvals.
- Switch model and reasoning effort without leaving the session.
- Stop the active turn while preserving DSH's queued follow-ups.
- Sanitize host-provided terminal control sequences and neutralize rendered
  links before they reach the terminal.
- Report its pane state to [Herdr](https://herdr.dev) when launched inside a
  Herdr pane, appearing there as the `deepseek` agent.

## Herdr integration

Inside a Herdr pane (`HERDR_ENV=1`) dsh-shell reports its own lifecycle state, so
Herdr's sidebar shows what this pane is doing without guessing from the screen:

| dsh-shell state | reported |
| --- | --- |
| attached, an approval or question is open | `blocked` (with a count in `--message`) |
| attached, a turn is running | `working` |
| attached and idle, or not attached | `idle` |

Herdr derives `done` itself, so it is never reported. The label is `deepseek`
because Herdr has no built-in kind for it — `herdr agent` lists `pi`, `claude`,
`codex`, … but not `deepseek` — which is precisely why the agent reports itself
over `herdr pane report-agent` instead of being screen-detected.

Reporting is transition-driven (setState runs per streamed frame, so a spawn per
frame would be absurd), every `herdr` invocation is fire-and-forget, and the
whole module is a no-op outside Herdr: a missing or failing `herdr` binary
cannot affect the shell.

## Quick start

### 1. Start a compatible DSH host

`dsh-shell` currently tracks the `0.1.0-rc.7` DSH client API exactly. Start the
matching Web host in the directory you want DSH to use:

```sh
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.7 web --no-open
```

The host listens on `http://127.0.0.1:3080` by default. Configure your model
and API key in the Web UI; `dsh-shell` does not read or store model credentials.

### 2. Build and run dsh-shell

In a second terminal:

```sh
git clone https://github.com/charleszheng44/dsh-shell.git
cd dsh-shell
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

To use a different loopback port:

```sh
pnpm start --host http://localhost:3081
```

Only loopback `http://` origins are accepted because the DSH host API does not
provide authentication or TLS.

### 3. Attach and talk

On first launch, the project picker opens automatically.

1. Choose a project, or choose **Create new project** and enter an existing
   directory path.
2. Choose a session, or choose **Create new session**.
3. Type a message and press <kbd>Enter</kbd>.

Your prompt appears after DSH records it. Open the same session in the Web UI
at any time; both clients follow the same log and live event stream.

## Keyboard guide

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Send the composer text, or answer the open question |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Recall prompt history; move in a picker when one is open |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Choose or create a project |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Choose or create a session |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Choose a model and reasoning effort |
| <kbd>Esc</kbd> | Cancel a picker, or stop the active turn |
| <kbd>Ctrl</kbd>+<kbd>U</kbd> | Move the last queued message back into the composer |
| <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Steer the last queued message into the active turn |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Allow the pending tool approval once |
| <kbd>Ctrl</kbd>+<kbd>R</kbd> | Reject the pending tool approval |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Quit and restore the terminal |

When DSH asks a question, enter an option number, comma-separated numbers for
a multi-select question, an exact option label, or a free-text answer.

## dsh-shell or dsh-TUI?

This comparison refers to the community
[`dsh-TUI`](https://github.com/ccch1mneyyy/dsh-TUI) project. Both are good
terminal interfaces for DeepSeek Harness, but they solve different problems.

| | `dsh-shell` | `dsh-TUI` |
| --- | --- | --- |
| Architecture | Remote client over DSH's structured HTTP/WebSocket API | In-process DSH plugin bundle |
| Best fit | You already run `dsh web` and want the same session in terminal and browser | You want a full terminal-first DSH application |
| State | The existing DSH host owns all execution and persistence | The TUI is composed into the DSH process |
| Scope | Projects, sessions, prompts, streaming, queue controls, questions, approvals, and model selection | Broader TUI features such as slash commands, file mentions, tool-card views, and plugin-integrated workflows |
| Tradeoff | Smaller surface and a clear client/host boundary | Deeper integration and more terminal-native features |

Choose `dsh-shell` when session continuity with the Web UI is the point. Choose
`dsh-TUI` when the terminal should be the complete DSH experience.

## Design boundaries

This repository owns terminal rendering, keyboard input, selectors,
connection state, and terminal cleanup. The DSH host owns agent execution,
prompt ordering, approvals, questions, session persistence, and workspace
state.

Current limitations:

- The DSH host must already be running and must match the pinned API version.
- There is no automatic reconnect; restart `dsh-shell` after a stream loss.
- Remote hosts, authentication, and TLS are intentionally unsupported.
- Slash commands, attachments, session search, rename, archive, delete, and
  fork remain Web UI workflows.
- This repository is installed from source; it is not currently published as
  a package.

The detailed architecture and protocol decisions live in
[`docs/spec/2026-08-17-thin-terminal-client.md`](docs/spec/2026-08-17-thin-terminal-client.md).

## Development

Requirements: Node.js `^22.19 || >=24` and pnpm 11.

```sh
pnpm install
pnpm dev
pnpm test
pnpm test:coverage
pnpm check
```

`pnpm check` runs the type checker, complete test suite, and production build.
Pull requests are welcome; keep the client thin, add focused tests for behavior
changes, and leave DSH-owned state and execution in the host.

## License

[MIT](LICENSE) © 2026 Charles Zheng. The Gentle Mist Blue palette and related
visual references are acknowledged in [Third-party notices](THIRD_PARTY_NOTICES.md).
