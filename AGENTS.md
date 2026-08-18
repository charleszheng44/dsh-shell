# Working agreements

`dsh-tui` is a thin terminal client for DeepSeek Harness. Keep agent execution, session persistence, prompt ordering, approvals, questions, and workspace ownership in the DSH host.

- Communicate with DSH through its versioned client API and structured event stream.
- Treat DSH session IDs as the shared identity used by terminal and web clients.
- Never read or write DSH session storage directly.
- Never interpret raw subprocess standard output as the conversation protocol.
- Keep terminal rendering, keyboard input, selection UI, reconnection, and terminal cleanup in this repository.
- Keep the project compatible with Node.js `^22.19 || >=24`.
- Add focused tests with behavior changes and run `pnpm check` before publishing changes.
