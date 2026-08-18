# dsh-tui

An independent terminal client for DeepSeek Harness.

## Status

Terminal proxy: connect to a loopback DSH host, list workspaces (projects)
and sessions, attach to a session by its DSH session ID, render recent
finalized user/assistant history and live assistant output as Markdown
(including fenced code blocks), and submit plain text to the attached
session.

## Architecture

One DSH host owns workspaces, sessions, agents, tools, persistence, queues,
approvals, questions, and streaming events. `dsh-tui` connects as a client
and renders those structured events with `@earendil-works/pi-tui`.

The terminal and Web UI attach to the same DSH session ID. They must connect
to the same running DSH host; separate DSH processes must not coordinate by
writing the same session database.

```text
                 +-- Web UI
DSH host --------+
                 +-- dsh-tui
```

This repository owns:

- terminal input and lifecycle;
- project and session selectors;
- transcript and Markdown rendering;
- client-side connection status.

It does not own agent execution, session persistence, prompt ordering, or
interpretation of raw process output.

## Development

Requirements: Node.js `^22.19 || >=24` and pnpm 11.

```sh
pnpm install
pnpm dev
pnpm check
pnpm build
```

Press `Ctrl+P` for the project selector, `Ctrl+S` for the session selector,
`Enter` to send the editor's text to the attached session, and `Ctrl+C` to
leave the application. Submitted text appears in the transcript only after
DSH logs it; a running session receives additional text through DSH's queue
policy.

## Limitations

- Only loopback `http:` hosts are accepted (`--host`, default
  `http://127.0.0.1:3080`); there is no authentication or TLS.
- No session or workspace creation, rename, archive, deletion, search, fork,
  model selection, or steering.
- No session or workspace creation, rename, archive, deletion, search, fork,
  model selection, or steering.
- No approvals, questions, attachments, slash commands, or automatic
  reconnect: losing the stream shows a disconnected state and requires a
  restart.
- The client pins the exact published DSH network-client version; an
  incompatible host fails loudly at `host.describe` before any selector
  opens.
