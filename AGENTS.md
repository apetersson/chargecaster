# Agent Playbook

## Frontend Screenshot Workflow
- Use `peekaboo__list` to confirm Chrome window title and ID when needed.
- Capture the current viewport with `peekaboo__image`, targeting the Chrome window; request JPEG output and save it under `/tmp/` (for example `/tmp/chrome-localhost-5173.jpg`).
- Reference the saved JPEG path in the reply so the user can open it locally if desired.
- Immediately describe the UI shown in the screenshot so the user receives quick visual feedback without opening the file.
- After the user restarts the frontend or backend, take a fresh capture and highlight any visual deltas in the explanation.

## Tooling Notes
- `peekaboo__list` reliably enumerates Chrome windows; the stem sometimes omits off-screen windows, so fall back to manual selection if no title match.
- `peekaboo__image` works well for JPEG captures; keep `capture_focus` at `foreground` to avoid blank screenshots. Saving under `/tmp` is safe and requires no extra cleanup. (avoid using peekaboo.analyze)
- Local `curl` calls to sandboxed ports fail without escalated permissions; rerun with `with_escalated_permissions: true` and supply a short justification.
- IntelliJ MCP tools are solid for read/search (`get_file_text`, `list_directory_tree`, `search_in_files`), but writes (`create_new_file`, `replace_text_in_file`, `apply_patch`) still fail intermittently—stick to shell-based edits when modifying files.
- `yarn` and other package scripts may emit cache warnings in the sandbox; they are harmless, but expect missing global folders on macOS runners.
- Backend config now loads once on startup; if `config.local.yaml` is missing or invalid the process aborts, so confirm the file before booting instead of trying to hot-reload it.
- When the user asks to "validate the build", run the full script set (`lint`, `typecheck`, `build`, `test`) defined in the affected package's `package.json` (e.g. `yarn workspace <pkg> lint/typecheck/build/test`) before replying.
- Vitest's `yarn workspace <pkg> test` can crash during NestJS bootstrap; capture or log the underlying `handleInitializationError` to surface the root cause instead of assuming tests ran.

## General Debugging Habits
- When chart markers or gauges should mirror a live summary metric, source the marker from the latest summary payload first and treat historical samples as a fallback so the visual stays anchored to the freshest reading.
- While normalising price or unit data from external inputs, inspect the magnitude before applying conversions—values already provided in cents or base units often ship without an explicit unit field, and blindly multiplying them can inflate downstream cost calculations.
