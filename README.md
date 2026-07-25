# hevy-agents-mcp

<div align="center">

**Your entire Hevy training history as a database an agent can actually query.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)
[![Fork of hevy-mcp](https://img.shields.io/badge/fork%20of-chrisdoc%2Fhevy--mcp-lightgrey.svg)](https://github.com/chrisdoc/hevy-mcp)

[What it does](#what-it-does) · [Quick start](#quick-start) · [Tools](#tools) · [How the numbers are derived](#how-the-numbers-are-derived)

</div>

## What it does

Hevy's API returns **at most 10 workouts per request**, with no date filter and
no bulk export. So an assistant asked *"how has my bench progressed since I
started?"* has two bad options: page through hundreds of requests, dragging
every workout object through the context window, or answer from the last few
weeks and hope that's representative.

`hevy-agents-mcp` fixes this by keeping a **local copy of your complete history**
and exposing it as SQL:

```text
Hevy API  →  read-only sync  →  local SQLite  →  run-training-query  →  your agent
```

One import, then incremental updates. After that, questions spanning years are a
single query instead of two hundred requests.

**Designed for agents as the primary user, not as an afterthought:**

- **SQL, not a fixed menu of endpoints.** An agent can ask things nobody
  pre-built a tool for — arbitrary date ranges, groupings, and granularity, in
  whatever shape it needs.
- **A self-documenting schema.** `describe-training-schema` returns the tables,
  views, column meanings, worked examples, *and* the modeling assumptions behind
  every derived figure.
- **Rejected queries explain themselves.** A bad column name comes back as
  `no such column: bodyweight` with a pointer to the schema tool, so the agent
  corrects itself instead of retrying blind.
- **Output formats that respect the context window.** `csv` and `markdown`
  alongside `json`, with row and byte caps that report when they fire.
- **Honest about what is measured and what is modelled.** Bodyweight loads and
  muscle attribution are assumptions, and every figure carries its basis.

### Example questions it can answer

> Across my entire history, find every six-week window where my bench improved
> faster than usual, and tell me what was different about my training then.

> Weekly volume per muscle group for the last two years, and which groups I've
> been neglecting relative to the same window last year.

> Which exercises have I plateaued on, controlling for equipment substitutions?

> What's my true rep-max at every rep count for squat, and how does that differ
> from my best estimated 1RM?

## Relationship to `hevy-mcp`

This is a fork of [`chrisdoc/hevy-mcp`](https://github.com/chrisdoc/hevy-mcp),
which solved the parts worth inheriting: the Hevy API client, MCP tool
contracts, authentication, stdio and Cloudflare transports, error policy, and
privacy-preserving telemetry. That work is excellent and this project would not
be worth building without it.

The difference is one of shape. Upstream is a **stateless proxy** — every request
forwards to Hevy and the response evaporates, which is exactly right for a
connector and exactly wrong for lifetime analysis. This fork adds the
**persistent, semantically explicit layer above it**: full-history sync, a local
analytical store, derived views, and agent-native SQL access.

**What changed:**

| | Upstream | This fork |
| --- | --- | --- |
| History access | 10 workouts per request | Whole history, one query |
| Analysis window | `get-training-summary`, 1–12 weeks | Unbounded |
| State | Stateless | Local SQLite, incremental sync |
| Query surface | Fixed tools | Read-only SQL + fixed tools |
| Workout writes | Supported | **Removed by design** — see below |

**Workout mutation is deliberately absent.** Upstream can create and update
workouts; this fork does not. The point is trustworthy analysis of a training
record, and a tool that cannot alter that record is easier to trust. Routine and
exercise-template writes remain, since those are additive and non-destructive.

Bug fixes that apply to the shared foundation are sent upstream rather than kept
here.

## Quick start

Requires **Node >= 22.5** (for the built-in `node:sqlite` module) and a Hevy API
key, which needs **Hevy PRO**. Get one at Hevy → Settings → Developer.

### 1. Install and import your history

```bash
git clone https://github.com/PV-Bhat/hevy-agents-mcp.git && cd hevy-agents-mcp && npm install
```

Put your key in `.env`:

```bash
echo "HEVY_API_KEY=your-hevy-api-key" > .env
```

Check the key and see how big the import will be:

```bash
node --env-file=.env packages/warehouse/src/cli.ts probe
```

Then import. Roughly one request per ten workouts — a 1,000-workout account
takes about two minutes:

```bash
node --env-file=.env packages/warehouse/src/cli.ts sync
```

### 2. Connect your client

Add to your MCP client configuration:

```json
{
	"mcpServers": {
		"hevy-agents": {
			"command": "npx",
			"args": ["-y", "hevy-agents-mcp"],
			"env": {
				"HEVY_API_KEY": "your-hevy-api-key",
				"HEVY_WAREHOUSE_DB": "/absolute/path/to/hevy-warehouse.db"
			}
		}
	}
}
```

See [`.mcp.json.example`](./.mcp.json.example). Without `HEVY_WAREHOUSE_DB` the
server still runs as a plain Hevy connector, and the warehouse tools are simply
not registered.

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `HEVY_API_KEY` | yes | Your Hevy API key. |
| `HEVY_WAREHOUSE_DB` | to enable the warehouse | Path to the SQLite file. Created if absent. |
| `HEVY_WAREHOUSE_TZ` | no | IANA zone for day and week bucketing. Defaults to the system zone. Changing it recomputes stored dates on next start. |

## Tools

### Warehouse

Registered only when `HEVY_WAREHOUSE_DB` is set, so the tool list never
advertises a capability the server cannot honor.

| Tool | Purpose |
| --- | --- |
| `describe-training-schema` | Tables, views, column meanings, conventions, caveats, worked examples, and the live modeling assumptions. Call this first. |
| `run-training-query` | A single read-only `SELECT` or `WITH` over the whole history. |
| `get-warehouse-status` | Coverage and freshness. |
| `sync-training-history` | Refresh from Hevy. `auto` applies changes since last sync; `full` re-reads everything and removes workouts Hevy no longer has. |

### Hevy passthrough

Inherited from upstream: read tools for workouts, routines, exercise templates,
routine folders, body measurements, and profile; write tools for routines,
routine folders, exercise templates, and body measurements.

## Safety model

Three independent locks, not one convention:

1. **The sync client cannot write to Hevy.** Every request passes through a
   wrapper that throws on any method other than `GET`, before a connection
   opens.
2. **The query connection is read-only at the engine level.** SQLite itself
   refuses writes, so no amount of creative SQL can mutate anything — the
   guarantee does not depend on a parser being clever.
3. **Statement validation** on top of that: single `SELECT`/`WITH` only,
   stacked statements and `PRAGMA`/`ATTACH` rejected, keyword matching done
   after stripping string literals and comments so an exercise named
   *"Attach Bar Row"* is not a false positive.

The worst case for a compromised query surface is a damaged **local copy**,
which a re-sync rebuilds in minutes. Your Hevy account is not reachable from it.

## How the numbers are derived

Some figures are **modelled, not measured**, and the choices move them
materially. All of it is reported by `describe-training-schema` so an agent can
state the basis alongside the number. Modeling decisions live in readable SQL
views rather than buried in code.

- **Warmup sets** are excluded from all volume, PR, and one-rep-max maths.
- **Volume** is `NULL`, never `0`, where weight × reps is meaningless — cardio,
  duration and unloaded work. Read `volume_basis` alongside `volume_kg`;
  reporting zero would make a run look like failed lifting.
- **Estimated 1RM** uses Epley over *effective* load, restricted to 1–12 reps.
  A weighted pull-up is not estimated from its belt plate alone. `e1rm_basis`
  distinguishes `measured` from `modelled_bodyweight`.
- **Muscle credit** gives the primary muscle 1.0 and each secondary 0.5.
  `is_primary` is exposed so any query can apply its own weighting.
- **Bodyweight movements** load `bodyweight × fraction`, per exercise: a pull-up
  moves nearly all of you, a push-up about two thirds, a crunch far less.
  Without this, bodyweight work either scores zero volume or lets a 25-rep
  crunch outrank a heavy squat.
- **Personal records** come in three flavours that disagree — heaviest single,
  rep-max at a given rep count, and best estimated 1RM. All three are available;
  say which you mean.

Inspect or change the bodyweight fractions. Views recompute on next start; no
re-sync needed:

```bash
node packages/warehouse/src/cli.ts fractions
```

```bash
node packages/warehouse/src/cli.ts set-fraction "Push Up" 0.7
```

### Exercise substitutions

Equivalent movements are separate templates in Hevy, so changing gyms breaks a
progression curve. Group them so they aggregate:

```bash
node packages/warehouse/src/cli.ts group "Bench" "Bench Press (Barbell)" "Bench Press (Dumbbell)"
```

Join `exercise_group_member` on `v_set.template_id` to query by group. Grouping
is a CLI operation because the MCP query surface is deliberately read-only.

> [!NOTE]
> The live Hevy API returns `exercise_type` values that differ from its published
> OpenAPI spec: `bodyweight_weighted` and `bodyweight_assisted` rather than the
> documented `*_reps` names, plus `steps_duration` and `floors_duration` which
> the spec omits entirely. This project follows the live API, verified against
> real data.

## Architecture

```text
packages/warehouse   schema, sync, semantic views, query guard, describe surface
packages/core        MCP tools and response contracts (runtime-neutral)
packages/node        node:sqlite driver, env wiring, stdio adapter — published
packages/hevy-client generated Hevy API client
packages/worker      Cloudflare HTTP/OAuth adapter
```

`packages/warehouse` has two entry points: the package root, which owns the
`node:sqlite` driver, and `/portable`, which must stay free of Node builtins
because `core` and the Worker import it. That split keeps a hosted Durable
Object SQLite path open. Boundaries are enforced by
`scripts/check-package-boundaries.mjs`.

Raw API JSON is preserved per workout, so changing a modeling decision rebuilds
derived rows locally without re-downloading from Hevy.

## Roadmap

- Hosted deployment on Cloudflare Durable Objects, one private database per user
- Hevy webhook support for sub-minute freshness after logging a workout
- Named analytics tools over the views for the most common questions

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Fixes to the inherited foundation are
welcome and will be offered upstream.

## License and acknowledgements

MIT. See [LICENSE](./LICENSE).

Built on [`chrisdoc/hevy-mcp`](https://github.com/chrisdoc/hevy-mcp) by
Christoph Kieslich, which contributed the Hevy client, MCP tool contracts,
transports, and telemetry design this project depends on.

Not affiliated with or endorsed by Hevy.
