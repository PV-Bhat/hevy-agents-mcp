# HEVY tool guide

The MCP server's live JSON Schemas are the source of truth. Inputs are derived
from Zod and validated before handlers run.

## Common reads

| Goal | Tool and important inputs |
| --- | --- |
| Recent workouts | `get-workouts`: `page`, `pageSize` (maximum 10) |
| Workout details | `get-workout`: `workoutId` |
| Workout total | `get-workout-count` |
| Incremental events | `get-workout-events`: `since`, `page`, `pageSize` (maximum 10) |
| Find an exercise | `search-exercise-templates`: `query`; optional `primaryMuscleGroup`, `refresh` |
| Exercise history | `get-exercise-history`: `exerciseTemplateId`; optional offset-aware ISO 8601 `startDate`, `endDate` |
| Browse exercises | `get-exercise-templates`: `page`, `pageSize` (maximum 100) |
| Saved programs | `get-routines`, `get-routine`, `get-routine-folders`, `get-routine-folder` |
| Account profile | `get-user-info` |
| Body measurements | `get-body-measurements`, `get-body-measurement` |

## Lifetime analytics and personal records

1. `get-warehouse-status` checks coverage, freshness, and timezone.
2. `sync-training-history` with `mode: "auto"` refreshes changes. Use
   `mode: "full"` only for an explicit rebuild or repair.
3. `describe-training-schema` returns current tables, semantic views,
   modeling assumptions, caveats, and worked queries.
4. `run-training-query` accepts one `SELECT` or `WITH` statement, a format of
   `json`, `csv`, or `markdown`, and `maxRows` from 1 through 5000.

For personal records, state whether the result is a measured maximum, a rep-max
at a specific rep count, or an estimated one-rep max. Warm-up sets are excluded
from PR and volume calculations. Bodyweight-adjusted results are explicitly
modeled rather than measured.

## Writes

The server can create or update routines, create routine folders, create custom
exercise templates, and create or update body measurements. Repeated create
calls may make duplicates. Logged workouts cannot be mutated.

## Failure conventions

- Out-of-range list pages may be normalized into empty end-of-list responses.
- Missing individual resources may be normalized into not-found results.
- Error diagnostics redact secrets and raw request headers.
- Rejected SQL returns an actionable reason rather than crashing the server.
