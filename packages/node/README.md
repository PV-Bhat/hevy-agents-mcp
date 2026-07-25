# hevy-agents-mcp

**Your entire Hevy training history as a database an agent can actually query.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/PV-Bhat/hevy-agents-mcp/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[Hevy](https://www.hevyapp.com/), built for AI agents as the primary user.

Hevy's API returns at most 10 workouts per request, with no date filter and no
bulk export. So an assistant asked *"how has my bench progressed since I
started?"* must either page through hundreds of requests or answer from the last
few weeks and hope that's representative.

This server keeps a local copy of your complete history and exposes it as SQL.
One import, then incremental updates. Questions spanning years become a single
query.

Full documentation:
**[github.com/PV-Bhat/hevy-agents-mcp](https://github.com/PV-Bhat/hevy-agents-mcp)**

## Requirements

- **Node >= 22.5** — for the built-in `node:sqlite` module
- A **Hevy API key**, which requires Hevy PRO (Hevy → Settings → Developer)

## Install

```bash
npx -y hevy-agents-mcp
```

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

Restart or reconnect your client after saving its configuration.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `HEVY_API_KEY` | yes | Your Hevy API key. |
| `HEVY_WAREHOUSE_DB` | to enable the warehouse | Path to the SQLite file. Created if absent. |
| `HEVY_WAREHOUSE_TZ` | no | IANA zone for day and week bucketing. Defaults to the system zone. |

Without `HEVY_WAREHOUSE_DB` the server runs as a plain Hevy connector and the
warehouse tools are not registered.

### First import

Clone the repository and run the sync CLI once — roughly one request per ten
workouts, so a 1,000-workout account takes about two minutes:

```bash
node --env-file=.env packages/warehouse/src/cli.ts sync
```

Afterwards the server keeps itself current through the `sync-training-history`
tool, which applies only what changed.

## Tools

Registered only when a warehouse is configured, so the tool list never
advertises a capability the server cannot honor:

| Tool | Purpose |
| --- | --- |
| `describe-training-schema` | Tables, views, column meanings, worked examples, and the modeling assumptions behind every derived figure. Call this first. |
| `run-training-query` | A single read-only `SELECT` over the whole history, in `json`, `csv`, or `markdown`. |
| `get-warehouse-status` | Coverage and freshness. |
| `sync-training-history` | Refresh from Hevy. |

Plus read tools for workouts, routines, exercise templates, routine folders,
body measurements, and profile, and write tools for routines, routine folders,
exercise templates, and body measurements.

**Workout mutation is deliberately absent.** This server exists to analyse a
training record, and a tool that cannot alter that record is easier to trust.

## Safety

Three independent locks:

1. The sync client throws on any HTTP method other than `GET`, before a
   connection opens — it cannot write to your Hevy account.
2. The query connection is opened read-only, so SQLite itself refuses writes
   regardless of the SQL supplied.
3. Statement validation on top: single `SELECT`/`WITH` only, stacked statements
   and `PRAGMA`/`ATTACH` rejected.

The worst case for a bad query is a damaged local copy, which a re-sync
rebuilds.

## Modelled versus measured

Some figures are modelled, not measured, and `describe-training-schema` reports
all of it so an agent can state the basis alongside the number. Warmups are
excluded from volume and PR maths; volume is `NULL` rather than zero where
weight times reps is meaningless; bodyweight movements use an editable
per-exercise fraction of bodyweight; secondary muscles receive half volume
credit.

## Programmatic API

The package exposes two named functions for applications that embed the MCP
server:

```ts
import { createNodeMcpServer, runStdioServer } from "hevy-agents-mcp";

const server = await createNodeMcpServer({ apiKey: process.env.HEVY_API_KEY! });
// Connect `server` to the transport owned by your application, or use:
await runStdioServer();
```

`createNodeMcpServer` never reads environment variables, connects a transport,
or installs process lifecycle handlers. The CLI-only `runStdioServer` function
owns those concerns.

## License

MIT. A fork of [`chrisdoc/hevy-mcp`](https://github.com/chrisdoc/hevy-mcp) by
Christoph Kieslich, which contributed the Hevy client, MCP tool contracts,
transports, and telemetry design this project builds on.

Not affiliated with or endorsed by Hevy.
