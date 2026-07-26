---
name: hevy
description: Use HEVY training data for workouts, exercise history, personal records, lifetime analytics, routines, templates, folders, body measurements, and profile. Trigger for HEVY, gym logs, lifting progress, programming, or local training warehouse questions.
---

# Hevy Agents

Use the local `hevy` MCP server. Only the user-supplied `HEVY_API_KEY` is
required. The warehouse is enabled automatically.

## Rules

- Never ask the user to paste their API key into chat. If it is missing, tell
  them to set `HEVY_API_KEY` in `~/.codex/.env` and restart.
- Prefer warehouse tools for multi-week / lifetime questions:
  `get-warehouse-status` → `sync-training-history` (if stale) →
  `describe-training-schema` → `run-training-query`.
- Prefer `get-workouts` / `get-workout` for recent sessions only.
- Search templates before exercise history when the exercise ID is unknown.
- Workout history is read-only. Confirm before routine/template/measurement
  writes.
- Paginate carefully (workouts max 10/page). Prefer SQL over paging all history.

See `references/tool-guide.md` for tool details.