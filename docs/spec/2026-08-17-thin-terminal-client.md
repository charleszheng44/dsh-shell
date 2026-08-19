# Thin terminal client design

Status: proposed

Date: 2026-08-17

Repositories:

- `deepseek-harness`: DSH Host, wire protocol, and published network client.
- `dsh-shell`: terminal presentation and keyboard input only.

## Decision

Build `dsh-shell` as a standalone Node.js process that connects to one already-running `dsh web` Host over its typed HTTP and WebSocket API. The TUI does not load Cordis, start an agent, open session storage, create another DSH Host, or define another session identity. Attaching means selecting a DSH `SessionId`; the Web UI can open the same ID and observe the same durable history and live events.

The work is three implementation PRs: one prerequisite PR in `deepseek-harness`, one read-only TUI PR, and one live input/output TUI PR. The final PR has two explicit validation checkpoints so streaming is proven before input is enabled. This design document is not counted as an implementation PR.

## Goal

The first usable release must:

1. Connect to a loopback DSH Web Host after verifying protocol compatibility.
2. List DSH Workspaces, presented as projects.
3. List ordinary, non-archived sessions for the selected project.
4. Attach to a selected session and render recent history and live assistant output, including Markdown code fences.
5. Submit plain text to the attached session.
6. Let the user switch projects or sessions without restarting the process.

## Simplicity rules

These rules are acceptance criteria:

- DSH owns agents, models, tools, session persistence, workspace persistence, prompt ordering, queues, approvals, questions, cancellation, and event production.
- The TUI owns only terminal lifecycle, selection, a small event-to-display projection, and text submission.
- The TUI uses DSH's structured API and event types. It never treats subprocess stdout as the conversation protocol.
- The TUI stores no session, project, transcript, attachment, or selection data on disk.
- The TUI has no plugin system, dependency injection container, database, durable cache, daemon, background worker, or configuration file.
- The TUI imports an ordinary Node ESM network-client entry published by DSH. It never imports DSH source files or the browser ModuleLoader bundle.
- The TUI does not copy the Web client runtime. It consumes only the Host description, Workspace list, Session list, history, mux stream, and prompt operations required by this release.
- Automatic reconnect is excluded. Stream loss becomes a visible disconnected state; restart establishes a fresh history baseline.
- Remote-network mode is excluded. The default Host is `http://127.0.0.1:3080`, and `--host` accepts loopback HTTP origins only while DSH has no authentication layer.
- No optimistic conversation rows are included. A submitted prompt appears only when DSH emits its logged `user/message` event.
- Slash commands are excluded. Input whose trimmed form begins with `/` is retained in the editor and rejected locally with a Web UI instruction.
- No session or Workspace creation, rename, archive, deletion, search, fork, model selection, steering, queue editing, cancellation, approval response, or question response is included.
- No syntax-highlighting dependency is included. Pi Markdown formats fenced code blocks; syntax highlighting can be evaluated later.

## Repository evidence

The design relies on these current DSH interfaces:

- `deepseek-harness/docs/architecture.md` defines the session log as the source of truth and directs UI integrations to drive agents and render session events.
- `deepseek-harness/packages/host/apiproxy/src/api/workspace.ts` exposes `workspace.list`, including ordered `sessionIds` and the archived-session set.
- `deepseek-harness/packages/host/apiproxy/src/api/sessions.ts` exposes `session.list`, `session.history`, and `session.prompt` with branded `SessionId` values and structured session events. Tail history includes chunks for an unfinished assistant response.
- `deepseek-harness/packages/host/apiproxy/src/api/events.ts` exposes `events.mux` and its session-event frames.
- `deepseek-harness/packages/host/apiproxy/src/api/host.ts` says a protocol version must be introduced when an independently released client appears.
- `deepseek-harness/packages/client/connection/src/client/web-api-client.ts` already implements HTTP upstream calls and WebSocket downlinks, including an `onOpen` callback, but its browser entry is not an ordinary configurable Node ESM client.
- `deepseek-harness/packages/client/connection/README.md` documents the loopback trust posture and the absence of authentication.
- `deepseek-harness/packages/core/session/src/surface.ts` defines append-origin message events as the durable source for a human transcript; replacement copies are model-only.
- `dsh-shell/src/cli.ts` proves that Pi can start in the alternate screen and restore the terminal on `Ctrl+C`.

## Architecture and ownership

```text
                         same DSH SessionId
                    +--------------------------+
                    |                          |
keyboard -> dsh-shell -> DSH HTTP API -> inbox -> agent
               ^          |
               |          +-> session log
               |                    |
               +---- events.mux <---+
                                    |
                                    +-> Web UI
```

Only one DSH Host runs. The Web UI and TUI are concurrent clients of that Host. They must not run separate DSH processes against the same session database.

`dsh-shell` is not a Cordis plugin. The API gateway remains a DSH plugin; the TUI is an external client executable. This keeps terminal concerns out of the harness and harness behavior out of the terminal repository.

The shared `SessionId` is the complete Web/TUI mapping for this release. A `Terminal attached` presence indicator would require separate transient state and is explicitly deferred.

## Protocol and network client prerequisite

An independently released client cannot infer compatibility from the DSH application version. PR 1 introduces a numeric `protocolVersion` in `host.describe` and exports the matching client-supported constant. Version equality is required in this pre-release protocol; the TUI exits before opening selectors or streams when the values differ.

PR 1 also publishes an ordinary Node ESM network-client entry with an explicit `URL` origin. It reuses DSH's current schemas and HTTP/WebSocket carrier. It must not require a browser `window`, the Cordis runtime, the Host webserver, or invariant plugins merely to import and use that entry.

The preferred home is an explicit `./network` export from `@deepseek-ai/dsh-client-connection`. The packed-install validation decides whether that package can serve a clean external consumer. If it cannot do so without pulling required Host-only peers into the consumer, stop and revise this design before creating another package; do not hide the failure with source imports or Git dependencies.

## Supported command line

The first release has one option:

```text
dsh-shell [--host http://127.0.0.1:3080]
```

Use `node:util.parseArgs`; do not add a command-line parsing dependency. Accept only `http:` origins whose hostname is exactly `127.0.0.1` or `localhost`. Reject credentials, non-root paths, query strings, fragments, and every other hostname or scheme. Normalize the accepted value to an origin before constructing the network client.

There is no configuration file or environment-variable fallback in the first release.

## Terminal interaction

The terminal has one transcript, one editor, one footer, and selection overlays:

```text
+ project / session / connection status ---------------------------+
|                                                                  |
| transcript: user text and assistant Markdown                     |
|                                                                  |
+ editor -----------------------------------------------------------+
| Ctrl+P project  Ctrl+S session  Enter send  Ctrl+C quit           |
| Approvals and questions: use Web UI                               |
+------------------------------------------------------------------+
```

`Ctrl+P` opens the project selector. Selecting a project immediately opens its session selector. `Ctrl+S` opens the session selector for the current project. `Ctrl+C` stops networking and the TUI and restores the terminal. The existing Pi `Editor` owns multiline editing and submit key behavior.

The project selector contains `All sessions` followed by the Workspaces returned by `workspace.list`. The session selector:

- hides IDs in `archivedSessionIds`;
- hides `origin: "subagent"` because ordinary `session.prompt` does not establish subagent continuation routing;
- hides blank sessions (the list shows attachable, non-blank sessions only);
- preserves each Workspace's `sessionIds` order within a Workspace;
- uses `session.list` order, newest first, for `All sessions`;
- labels a row with the `title` projection when it is a string, otherwise the basename of `cwd`, otherwise the session ID;
- appends a `＋ Create new session` action row, and an empty project shows
  only that action (the picker never attaches by itself).

The project picker appends a `＋ Create new project` action row. Selecting it
opens a path-entry modal (pi `Input`); Enter submits the trimmed path to
`workspace.create` — which registers an EXISTING directory, the host does no
mkdir — and ESC returns to the refreshed project picker. A failed create
surfaces the host error in the header and reopens the picker. On success the
new (or idempotently adopted) project becomes the selection and its session
picker opens.

Selecting `＋ Create new session` calls `session.create` with the selected
Workspace's id — or with no project under `All sessions`, which uses the Host
cwd — and attaches to the fresh blank session immediately. A failed create
surfaces the error and reopens the session picker. Both writes are never
retried; the pickers refresh both Workspace and Session lists when they open,
so a separate Host event projection for sidebar changes is unnecessary.

## Terminal-safe text

Pi `Text` and `Markdown` preserve ANSI sequences. Every string received from DSH must therefore pass through one `terminalSafeText()` function before reaching any Pi component. This includes model output, user-message echoes, Workspace and Session titles, paths, IDs used as fallbacks, notices, and error messages.

`terminalSafeText()` must:

1. normalize CRLF and bare CR to LF;
2. call Node's `stripVTControlCharacters()`;
3. remove remaining C0 and C1 controls except LF and tab.

Sanitization happens only at the display edge. It must not modify text submitted to DSH. Pi theme functions may add their own trusted ANSI styling after sanitization.

Tests must cover CSI cursor/screen commands, OSC title and clipboard sequences, BEL, backspace, CR, C1 controls, ordinary Unicode, and fenced Markdown.

## Minimal internal interfaces

The TUI keeps one narrow port so orchestration tests do not fake the complete DSH API. Unary transport failures are folded into the same `RpcResult<T>` form as DSH business errors. The port uses DSH's exported `WorkspaceView`, `SessionSummary`, `HistoryEntry`, `SessionId`, and `MuxFrame` types rather than local copies.

```ts
interface DshPort {
  describe(signal?: AbortSignal): Promise<RpcResult<HostDescription>>
  listWorkspaces(signal?: AbortSignal): Promise<RpcResult<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
  }>>
  listSessions(signal?: AbortSignal): Promise<RpcResult<{
    items: SessionSummary[]
  }>>
  loadHistory(sessionId: SessionId, signal?: AbortSignal): Promise<RpcResult<{
    events: HistoryEntry[]
    hasMore: boolean
  }>>
  stream(signal: AbortSignal, onOpen: () => void): AsyncIterable<MuxFrame>
  prompt(sessionId: SessionId, text: string, signal?: AbortSignal): Promise<RpcResult<{
    accepted: true
  }>>
}
```

`DshPort` is not a general SDK. `src/dsh.ts` delegates directly to the published network client, folds unary transport errors, and strips RPC envelopes from stream frames. Tests use a small in-memory fake of this exact interface.

Attachment lifecycle is one discriminated union rather than parallel mutable fields:

```ts
type AttachmentState =
  | { phase: "none" }
  | {
      phase: "loading"
      sessionId: SessionId
      generation: number
      buffered: SessionEvent[]
    }
  | {
      phase: "attached"
      sessionId: SessionId
      generation: number
      lastSeq: number
      transcript: readonly TranscriptRow[]
      partial: PartialAssistant | undefined
      sending: boolean
    }

interface AppState {
  connection: "connecting" | "connected" | "disconnected"
  projects: readonly ProjectRow[]
  sessions: readonly SessionRow[]
  selectedProject: WorkspaceId | "all" | undefined
  attachment: AttachmentState
  notice: string | undefined
}
```

Use direct method calls and explicit Pi render requests. Do not add a state-management library.

Expected source files after implementation:

```text
src/cli.ts          argument parsing and idempotent process/terminal cleanup
src/dsh.ts          typed DSH API adapter and DshPort
src/app.ts          selection, attachment, streaming, and prompt orchestration
src/transcript.ts   pure SessionEvent-to-row projection
src/ui.ts           Pi components, terminalSafeText(), and key bindings
tests/              node:test unit and orchestration tests
```

Files may be combined when the result is clearer. Do not introduce directories or base classes for hypothetical features.

## Runtime data flow

### Startup

The final interactive application starts in this order:

1. Parse and validate the loopback Host origin.
2. Construct the DSH network client.
3. Call `host.describe` and require the Host `protocolVersion` to equal the client-supported constant.
4. Start consuming `events.mux`; constructing its async iterable is not sufficient because the carrier is lazy.
5. Await its physical `onOpen` callback while the consumer continues draining frames.
6. Mark the connection connected.
7. Fetch `workspace.list` and `session.list` concurrently.
8. Open the project selector, then the session selector.
9. Attach locally to the chosen `SessionId`.

PR 2 is read-only and stops after the protocol handshake, lists, and a history snapshot. PR 3 adds steps 4–6 before claiming live attachment.

### Gap-free attachment

After stream readiness, attachment uses one synchronization rule:

1. Increment an attachment generation, install `loading`, and buffer `session/event` frames for the selected ID.
2. Request the tail `session.history` page without specifying `maxMessages`, leaving page size policy with DSH.
3. Fold every history event in sequence, including raw chunks and ignored events, and record the page's greatest sequence.
4. Apply buffered events in arrival order. Drop overlap where `seq <= lastSeq`; require every new event to have `seq === lastSeq + 1`.
5. Install `attached` and apply subsequent selected-session events directly under the same overlap and continuity rules.
6. Abort work when possible and ignore every result or frame belonging to an older attachment generation after a switch.

Any initial-buffer or steady-state sequence jump marks the connection disconnected and disables input. Under the v1 no-reconnect policy, the user restarts to establish a new authoritative history cut rather than viewing a silently incomplete transcript.

### Transcript projection

History and live events use the same pure projector:

- All events advance the sequence watermark, even when they do not render.
- Only append-origin (`surfaceOp === "append"`) `user/message` and `assistant/message` events may create finalized transcript rows. Model-only replacement copies do not render.
- A `user/message` renders only when `source.kind === "user"`; injected context does not masquerade as terminal input.
- `assistant/chunk` accumulates visible text by block index for its turn and step. `block-start`, `text-delta`, and `block-end` update that accumulator. Reasoning, usage, and tool-argument deltas are deliberately not displayed.
- A finalized assistant `block-end` may contribute its text or a compact `Tool: <name>` marker. Images render `[image]`.
- `llm/retry` clears the failed turn/step partial so abandoned text does not remain beside the retry.
- `assistant/message` replaces the matching partial with finalized text and compact tool-call markers; it never appends a duplicate partial/final pair.
- Unknown events and block kinds do not render but still advance the sequence watermark.

Tail history deliberately includes chunks for an unfinished response. Folding history chunks before buffered/live events ensures attaching mid-response renders the complete prefix rather than only deltas produced after attachment.

Both finalized and partial assistant text pass through `terminalSafeText()` and Pi's `Markdown`. Pi handles complete and incomplete fenced code blocks, so no second Markdown parser is introduced.

Approval and question frames are ignored in v1. A static footer always states that interactions require the Web UI. Keeping dynamic notices would require per-session pending state because pending requests replay only when the mux opens; that state is outside the basic proxy.

### Prompt submission

1. Require an attached session, connected stream, non-blank text, and no in-flight submission.
2. Reject trimmed input beginning with `/`, retain it, and show `Slash commands require the Web UI`.
3. Send the original, unsanitized text as one text content part through `session.prompt` with `mode: "queue"`.
4. Set `sending: true` while the unary call is in flight.
5. On acceptance, clear the editor and show `Accepted by DSH`; do not append a transcript row.
6. On a business or transport error, retain the text and show the terminal-safe DSH error.
7. Wait for the logged append-origin `user/message` before showing the prompt.

Always using `queue` leaves running-turn policy in DSH and avoids a steer/queue choice in the terminal.

## Failure and shutdown behavior

| Failure | Required behavior |
|---|---|
| DSH is unreachable at startup | Restore the terminal, print the origin and safe error, exit nonzero. |
| Protocol version differs | Do not open streams or selectors; print both versions and exit nonzero. |
| Workspace or Session list fails | Keep the current selection, show the safe DSH error, allow picker retry. |
| Selected Session disappears before history loads | Return to the session selector with `Session no longer exists`. |
| Old history or prompt resolves after a switch | Ignore it by attachment generation. |
| Event sequence jumps | Mark disconnected, disable input, instruct the user to restart. |
| Event stream closes, throws, or emits `stream/error` | Mark disconnected, disable input, instruct the user to restart. |
| Prompt is rejected | Preserve editor text and show the safe structured error. |
| Render code throws | Run the one shutdown path, print the safe error, exit nonzero. |
| `Ctrl+C`, OS `SIGINT`, or `SIGTERM` | Abort networking and restore terminal state exactly once. |

One lifecycle owner holds a root `AbortController`, the active stream-pump promise, signal disposers, and an idempotent shutdown promise. Every exit path aborts networking, restores the alternate screen, mouse mode, raw mode, and cursor synchronously in `finally`, waits for the abort-driven pump to settle, removes signal handlers, and sets the exit status. The DSH network-client test must prove abort closes the WebSocket so TUI shutdown needs no timeout or forced process exit.

Lifecycle tests cover terminal `Ctrl+C`, OS `SIGINT`, `SIGTERM`, stream failure, render failure, and repeated shutdown. Each must stop the terminal once and leave no stream task or socket handle.

## Security

DSH currently has a Host/reachability fence but no authentication layer. The first TUI therefore connects only to loopback HTTP origins. It sends no credentials and stores none. Expanding beyond loopback requires a DSH authentication design and is not a TUI-only change.

DSH-provided content is untrusted terminal input even though the wire is typed. All such content is sanitized at the display edge as specified above; event content is never written directly to stdout while terminal control is active.

## Delivery plan: three implementation PRs

Each PR has one observable value, automated tests, and a manual validation point. A later PR must not merge until the preceding point passes. Avoid drive-by refactors.

### PR 1 — DSH: versioned external network client

Repository: `deepseek-harness`

Purpose: make the existing typed HTTP/WebSocket carrier safely consumable by an independently released Node client. Do not add a TUI package or terminal behavior.

Expected changes:

- Add `protocolVersion` to the client-safe `host.describe` response, its schema, implementation, and tests.
- Export one numeric protocol-version constant used by the Host response and external client compatibility check.
- Add an ordinary Node ESM `./network` entry to `@deepseek-ai/dsh-client-connection` that accepts an explicit `URL` origin and exports the typed API client and protocol types needed by `dsh-shell`.
- Preserve same-origin behavior for the existing browser entry.
- Ensure importing and using `./network` neither executes the browser ModuleLoader bundle nor requires the consumer to install Cordis, Host webserver, or invariant peers. Mark Host-only peers optional for this face if that is sufficient.
- Reuse standard `fetch`, `WebSocket`, `AbortController`, current DSH schemas, and the existing `onOpen` callback.
- Update public JSDoc, the connection README, generated contract outputs affected by `host.describe`, and the required DSH Agent Note.
- Do not add another Host endpoint, a high-level Session facade, a TUI-specific projection, authentication, or reconnect behavior.

Expected areas, to be confirmed against the current tree before editing:

```text
packages/host/apiproxy/src/api/host.ts
packages/host/apiproxy/src/api/host.schema.ts
packages/host/apiproxy/src/api-proxy.ts
packages/client/connection/src/network.ts
packages/client/connection/package.json
packages/client/connection/tsdown.config.ts
packages/client/connection/tests/
packages/client/connection/README.md
.agents/notes/
```

Automated verification:

```sh
pnpm exec vitest run packages/host/apiproxy/tests packages/client/connection/tests
pnpm run typecheck
pnpm run build
pnpm run hygiene
pnpm run doc-sync
```

Use the DSH pre-push workflow to narrow the focused Vitest paths if the repository has more precise owning tests. Record only commands actually run. No transcript snapshot is expected because this PR changes transport metadata and publication only; add one if implementation changes assembled user output.

Validation point A:

From an empty temporary production project, install the packed client-connection package and import only `@deepseek-ai/dsh-client-connection/network`. The consumer declares no Cordis, Host webserver, or invariant dependency and receives no missing-peer warning. It can call `host.describe`, `workspace.list`, and `session.list` against `http://127.0.0.1:3080`, open and abort `events.mux`, and exit without a live handle. Tests also prove that a mismatched protocol version is detectable before stream creation and that browser construction retains same-origin behavior.

Handoff/merge condition:

Merge and publish the DSH package version before PR 2 updates `dsh-shell`. Record the released exact version in PR 2; do not use a Git dependency, source import, or `file:` link.

### PR 2 — dsh-shell: safe read-only selection and attachment

Repository: `dsh-shell`

Depends on: validation point A and the published DSH client version.

Purpose: deliver a useful read-only terminal viewer that lists projects and Sessions, verifies Host compatibility, attaches by `SessionId`, and formats historical Markdown safely.

Expected changes:

- Add an exact dependency on the released DSH network client.
- Add the read-only `DshPort` operations and direct network adapter in `src/dsh.ts`.
- Parse and validate `--host` with `node:util.parseArgs`.
- Call `host.describe` and reject protocol mismatch before showing selectors.
- Add project and Session row derivation with the filters, order, and labels defined above.
- Add project/session Pi `SelectList` overlays and the attached transcript layout.
- Add `terminalSafeText()` and apply it to every DSH-derived display string.
- Load one DSH-managed tail history page and use the shared event projector to render append-origin user/assistant Markdown. Fold historical chunks so an unfinished partial is already correct when PR 3 supplies live deltas.
- Add a `node:test` suite using the existing `tsx` dependency; do not add a test framework.
- Update `pnpm check` to run typecheck, tests, and build.

Automated verification:

```sh
pnpm check
```

Tests cover Host-origin rejection, protocol mismatch, project/session filtering and ordering, title fallback, empty project selection, history business failure, stale attach suppression, append-versus-replacement events, in-flight history partial reconstruction, terminal control sanitization, fixed-width fenced Markdown, and idempotent terminal cleanup.

Validation point B:

Against a running DSH Web Host, the user can open both selectors, choose a non-archived ordinary Session, and see the same recent finalized user/assistant history as the Web UI. A history response ending in an unfinished assistant stream shows its full recorded prefix. A fenced code block has Markdown code-block presentation. Crafted terminal-control content cannot move the cursor or change terminal state. The run performs no DSH mutation, and `Ctrl+C` restores the terminal.

Handoff/merge condition:

The reviewer confirms that `dsh-shell` imports only the ordinary published network entry, contains no DSH source copy, requires no DSH Host runtime package directly, writes no local state, and passes `pnpm check` before PR 3 begins.

### PR 3 — dsh-shell: complete live input/output proxy

Repository: `dsh-shell`

Depends on: validation point B.

Purpose: add the one live stream and plain-text submission needed to complete the terminal proxy. Keep streaming and input as two reviewable commits with separate validation checkpoints inside this PR.

#### Commit/checkpoint C — live output

Expected changes:

- Widen `DshPort` with `stream(signal, onOpen)` and start consuming it before awaiting readiness.
- Add the attachment-generation and history/buffer barrier.
- Require contiguous event sequences after the history tail; disconnect on a gap.
- Feed history, buffered events, and live events through the same pure projector.
- Reconstruct partial text by block index, clear it on `llm/retry`, and replace it on the finalized assistant message.
- Ignore other Sessions and approval/question frames; keep the static Web UI notice.
- Update Pi components in place and request renders; never append raw event content to stdout.
- Treat stream end as disconnected; do not add reconnect.

Automated verification:

```sh
pnpm check
```

Tests cover delayed stream readiness, an event during history load, frames from another Session, a switch during history load, overlap deduplication, initial and steady-state sequence gaps, block-indexed text deltas, history-prefix plus live-suffix stitching, incomplete code fences, retry clearing, finalized replacement without duplication, replacement surface events, unknown-event sequence advancement, stream error, abort, and shutdown with no pending stream handle.

Validation point C:

With the same Session open in the Web UI and TUI, output initiated from the Web UI streams into the terminal exactly once. Attaching during a response shows the complete prefix plus new deltas. Switching Sessions prevents old-session frames from rendering. Closing the DSH Host changes the footer to disconnected instead of hanging or retrying.

Do not begin the input commit until checkpoint C passes and its commit is independently reviewable.

#### Commit/checkpoint D — plain-text input

Expected changes:

- Widen `DshPort` with `prompt` and enable the Pi editor only for a connected, attached Session.
- Submit original text through `session.prompt` with `mode: "queue"`.
- Reject blank and slash-command input locally.
- Add in-flight guarding, accepted status, retained text on failure, and attachment-generation suppression for late results.
- Keep approvals/questions, images, steering, queue editing, and cancellation out of scope.
- Update README startup instructions, keys, validation recipe, and limitations.

Automated verification:

```sh
pnpm check
```

Tests prove that one Enter submission produces one call for the selected branded Session ID, whitespace-only and slash-command input make no call, concurrent submission is blocked, acceptance clears the editor without adding a row, rejection preserves text, a late old-session response cannot alter the new view, and disconnected state disables submission.

Validation point D:

Run a keyless two-client smoke using DSH's mock LLM:

```sh
# Terminal 1, from deepseek-harness
pnpm run mock:llm -- --port 8000 --api-key mock-key --sequence slow_success --repeat-last --success-text $'```ts\nconst answer = 42\n```'

# Terminal 2, from deepseek-harness
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 DEEPSEEK_API_KEY=mock-key pnpm dsh --profile web

# Terminal 3, from dsh-shell
pnpm dev -- --host http://127.0.0.1:3080
```

With Web UI and TUI attached to the same `SessionId`, text entered in the TUI appears in the Web UI only after DSH logs it, and the assistant response streams into both clients. The fenced TypeScript response renders as a code block. A running Session receives additional text through DSH's queue policy. Killing the TUI neither stops DSH nor changes the Session.

Handoff/merge condition:

The reviewer verifies checkpoints C and D separately, runs `pnpm check` on the final tree, performs the keyless two-client smoke, confirms cleanup after every exit path, and confirms no deferred feature entered the PR.

## Validation matrix

| Requirement | First proven | Automated proof | Manual proof |
|---|---|---|---|
| External Node transport | PR 1 | Explicit-origin HTTP/WS, abort, packed import | Packed consumer against DSH |
| Protocol compatibility | PR 1 | Host schema and mismatch tests | Compatible client reaches selectors |
| List projects | PR 2 | Workspace projection tests | Project selector matches Web UI |
| List Sessions | PR 2 | Filtering, ordering, and label tests | Selector matches chosen project |
| Attach by shared ID | PR 2 | Generation and history tests | Same recent history in Web UI/TUI |
| Terminal safety | PR 2 | CSI/OSC/control sanitization tests | Crafted content cannot control terminal |
| Markdown/code blocks | PR 2 | Fixed-width render test | Historical fence renders correctly |
| Live streaming | PR 3/C | Readiness, buffer, gap, partial tests | Web-initiated output appears once |
| Session switching | PR 3/C | Other-session and stale-attach tests | Old Session stops updating terminal |
| Text input | PR 3/D | Prompt call, guard, and failure tests | Prompt/response appear in both clients |
| Terminal cleanup | Every TUI checkpoint | Idempotent lifecycle tests | Ctrl+C, signals, and Host-loss smokes |

## Explicitly deferred

Defer these features until all validation points pass and real use demonstrates a need:

- automatic reconnect and cursor recovery;
- creating projects or Sessions;
- remembering the last project or Session;
- remote Hosts, authentication, TLS, SSH, or tunneling;
- dynamic approval/question state and response UI;
- slash commands, steering, queue inspection/editing, cancellation, and model selection;
- attachment upload/download and inline images;
- detailed tool cards, diffs, terminal emulation, and syntax highlighting;
- Session presence such as `Terminal attached` in the Web UI;
- themes, plugin APIs, tabs, split panes, search, mouse-only actions, and configuration files.

## Alternatives rejected

### Reuse the complete Web client runtime

It owns rich projection and reconnect behavior, but external composition would pull Cordis, Typert Remote assembly, Web-oriented packages, React/Zustand dependencies, and UI-domain registrations into a much smaller terminal surface. Six direct operations plus one small projector are less integration and release coupling.

### Add a TUI-specific DSH Host API

A `terminal.attach` or transcript endpoint would couple terminal presentation to the Host and duplicate information available from current Session and event APIs. The prerequisite is a versioned Node transport, not another behavior endpoint.

### Run a DSH Host inside dsh-shell

This would increase startup and teardown ownership and could create separate authorities for Web and terminal clients. The user runs `dsh web`; the TUI connects to it.

### Proxy raw stdin/stdout

Raw output loses durable event identity, history replay, multi-client consistency, and structured Markdown content. The typed DSH protocol is the proxy interface.

### Add automatic reconnect immediately

Correct reconnect requires a new history cut, another stream-readiness barrier, and gap repair. A visible disconnect is simpler and safer for v1. Reconnect can be a later isolated PR with explicit loss/duplication tests.

### Track dynamic approvals and questions

Pending interactions replay when the mux opens, possibly before a Session is selected. Correct later notices require a per-Session pending map and RPC-envelope identities. A static Web UI notice satisfies the basic proxy without that state.

## Agent handoff checklist

An implementing agent starts each PR by reading this document and the `AGENTS.md` in the repository it will change.

For PR 1, also read `deepseek-harness/docs/architecture.md`, `deepseek-harness/docs/defensive-patterns.md`, the client-connection and API Proxy READMEs/tests, and the DSH Agent Note instructions. Use the DSH pre-push skill to select final checks. Do not change Session event fields or add another Host endpoint unless fresh evidence proves the planned network entry cannot work; if that occurs, stop and revise this design.

For PRs 2–3, preserve the narrow `DshPort`, use the exact released DSH package version, and keep tests at the application seam rather than mocking Pi internals. Before coding, inspect the preceding validation evidence and verify its merge/release prerequisite.

For every PR or named checkpoint:

1. Restate its purpose and non-goals in the implementation plan.
2. Confirm the prerequisite validation point passed.
3. Confirm the expected paths against the current repository before editing.
4. Make only the files needed for the observable value.
5. Add or update tests in the same commit as behavior.
6. Run the listed automated verification and record only commands actually run.
7. Perform the named manual validation before merge or the next checkpoint.
8. Review for terminal-control injection, sequence gaps, accidental harness logic, persistence, speculative abstraction, and new dependencies.
9. Leave a handoff containing the commit, changed interfaces, commands and results, manual result, remaining limitations, and next prerequisite.

If implementation requires materially more state, another persistent identifier, a new behavior endpoint, or a broad dependency graph, stop and request a design revision. Complexity is evidence that the thin-proxy requirement is being violated, not a reason to quietly broaden the PR.
