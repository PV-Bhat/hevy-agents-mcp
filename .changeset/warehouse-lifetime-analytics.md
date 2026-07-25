---
"hevy-agents-mcp": major
---

Add an optional local training warehouse for lifetime analysis.

Hevy's API returns at most 10 workouts per request with no date filter or bulk
export, so questions spanning years are impractical through pagination alone.
When `HEVY_WAREHOUSE_DB` is set, the server keeps a local SQLite copy of the
full history and exposes it as SQL.

Four tools are registered only when a warehouse is configured, so a
pass-through server still advertises exactly what it can honor:

- `describe-training-schema` — tables, views, conventions, caveats, worked
  examples, and the live modeling assumptions
- `run-training-query` — a single read-only `SELECT` over the whole history
- `get-warehouse-status` — coverage and freshness
- `sync-training-history` — refresh from Hevy (`auto` or authoritative `full`)

The sync path cannot modify the Hevy account: every request goes through a
client that rejects any non-GET method, and the query connection is opened
read-only so SQLite refuses writes regardless of the SQL supplied.

Derived figures are explicit about being modelled rather than measured.
Warmups are excluded from volume and PR maths; volume is `NULL` rather than
zero where weight times reps is meaningless; bodyweight movements use an
editable per-exercise fraction of bodyweight; secondary muscles receive half
volume credit with `is_primary` exposed for re-weighting.

Note that the live Hevy API returns `exercise_type` values differing from its
published OpenAPI spec (`bodyweight_weighted` and `bodyweight_assisted` rather
than the documented `*_reps` names, plus `steps_duration` and
`floors_duration`). The warehouse follows the live API.

**Breaking:** `create-workout` and `update-workout` are removed. This server
exists to analyse a training record, and a tool that cannot alter that record
is easier to trust. Routine, routine-folder, exercise-template and
body-measurement writes are unaffected, since those are additive rather than
destructive to logged history. Callers that logged or edited workouts through
this server must use the Hevy app or upstream `hevy-mcp`.

**Breaking:** requires Node >= 22.5 for the built-in `node:sqlite` module.
