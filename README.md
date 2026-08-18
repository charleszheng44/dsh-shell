# dsh-tui

An independent terminal client for DeepSeek Harness.

## Status

The repository currently contains the terminal application shell. Connecting it to DSH requires a versioned external client package from `deepseek-harness`; until that exists, the executable deliberately reports that it is disconnected.

## Architecture

One DSH host owns workspaces, sessions, agents, tools, persistence, queues, approvals, questions, and streaming events. `dsh-tui` connects as a client and renders those structured events with `@earendil-works/pi-tui`.

The terminal and Web UI attach to the same DSH session ID. They must connect to the same running DSH host; separate DSH processes must not coordinate by writing the same session database.

```text
                 +-- Web UI
DSH host --------+
                 +-- dsh-tui
```

This repository owns:

- terminal input and lifecycle;
- project and session selectors;
- transcript and Markdown rendering;
- client-side connection status and reconnection.

It does not own agent execution, session persistence, prompt ordering, or interpretation of raw process output.

## Development

Requirements: Node.js `^22.19 || >=24` and pnpm 11.

```sh
pnpm install
pnpm dev
pnpm check
pnpm build
```

Press `Ctrl+C` to leave the application shell.
