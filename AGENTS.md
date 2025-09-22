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
- IntelliJ MCP file tools are fast for reads but flaky for new writes; editing via `shell` (heredoc + `cat`/`apply_patch`) has proven more reliable for file creation and updates.
- `yarn` and other package scripts may emit cache warnings in the sandbox; they are harmless, but expect missing global folders on macOS runners.
- Backend config now loads once on startup; if `config.local.yaml` is missing or invalid the process aborts, so confirm the file before booting instead of trying to hot-reload it.

## General Debugging Habits
- When chart markers or gauges should mirror a live summary metric, source the marker from the latest summary payload first and treat historical samples as a fallback so the visual stays anchored to the freshest reading.
- While normalising price or unit data from external inputs, inspect the magnitude before applying conversions—values already provided in cents or base units often ship without an explicit unit field, and blindly multiplying them can inflate downstream cost calculations.
