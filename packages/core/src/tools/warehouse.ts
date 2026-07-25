import { z } from "zod";
import {
	describeSchema,
	renderSchemaText,
	runQuery,
	QueryRejectedError,
} from "@hevy-mcp/warehouse/portable";
import {
	schemaDescriptionResponse,
	trainingQueryResponse,
	warehouseStatusResponse,
	warehouseSyncResponse,
} from "../utils/response-formatter.js";
import { readOnlyAnnotations } from "../utils/tool-annotations.js";
import { describeTool } from "../utils/tool-descriptions.js";
import type { InferToolParams } from "../utils/tool-helpers.js";
import type { ToolDefinition } from "./define-tool.js";
import type { ToolRuntime } from "./tool-runtime.js";

const runQuerySchema = {
	sql: z
		.string()
		.min(1)
		.describe(
			"A single read-only SELECT or WITH statement against the local training warehouse. Call describe-training-schema first to learn the tables, views and conventions.",
		),
	format: z
		.enum(["json", "csv", "markdown"])
		.default("json")
		.describe(
			"json for programmatic use; csv or markdown are far cheaper in tokens for wide or long result sets.",
		),
	maxRows: z.coerce
		.number()
		.int()
		.min(1)
		.max(5000)
		.default(500)
		.describe("Row cap. Aggregate in SQL rather than raising this."),
} as const;

const syncSchema = {
	mode: z
		.enum(["auto", "full"])
		.default("auto")
		.describe(
			"auto applies only changes since the last sync (fast). full re-reads the entire history from Hevy.",
		),
} as const;

type RunQueryParams = InferToolParams<typeof runQuerySchema>;
type SyncParams = InferToolParams<typeof syncSchema>;

/**
 * Returns a caller-facing explanation for query failures the agent can fix,
 * or null for anything that should be treated as a genuine server fault.
 *
 * SQLite's own messages ("no such column: bodyweight") are safe to pass
 * through: they describe only the local schema, which describe-training-schema
 * already publishes in full.
 */
function describeQueryFailure(error: unknown): string | null {
	if (error instanceof QueryRejectedError) return error.message;
	if (error instanceof Error && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (code === "ERR_SQLITE_ERROR") {
			return `SQLite rejected the query: ${error.message}. Call describe-training-schema to confirm table, view and column names.`;
		}
	}
	return null;
}

function daysBetween(from: string, to: Date): number | null {
	const parsed = Date.parse(from);
	if (!Number.isFinite(parsed)) return null;
	return Math.floor((to.getTime() - parsed) / 86_400_000);
}

export const warehouseToolDefinitions = [
	{
		name: "describe-training-schema",
		feature: "warehouse" as const,
		operation: "describe" as const,
		description: describeTool({
			summary:
				"Read-only. Returns the full schema of the local training warehouse: tables, views, column meanings, modeling conventions, caveats and worked example queries.",
			aliases: [
				"what can I query",
				"training database schema",
				"how is volume calculated",
			],
			useCase:
				"Call this before run-training-query, and whenever a query returns something surprising. It states exactly how volume, one-rep-max estimates and muscle attribution are defined.",
			importantNotes:
				"Reading this is much cheaper than guessing at column names. It also lists the semantic decisions, which are assumptions rather than facts.",
		}),
		inputSchema: {},
		outputSchema: schemaDescriptionResponse.outputSchema,
		annotations: readOnlyAnnotations("Describe Training Schema"),
		kind: "read" as const,
		responseContract: schemaDescriptionResponse,
		execute: async (runtime: ToolRuntime) =>
			renderSchemaText(describeSchema(runtime.getWarehouse().read)),
	},
	{
		name: "run-training-query",
		feature: "warehouse" as const,
		operation: "query" as const,
		description: describeTool({
			summary:
				"Read-only. Runs a SELECT query against the complete local copy of the user's training history and returns the rows.",
			aliases: [
				"query my training data",
				"analyse my whole history",
				"lifetime training analysis",
			],
			useCase:
				"Use for any question about training history, at any granularity or date range: progression, volume by muscle, personal records, plateaus, period comparisons. Prefer this over paging through get-workouts, which reads at most 10 workouts per call.",
			importantNotes:
				"Only a single SELECT or WITH statement is accepted; the connection is read-only so no query can modify anything. Call describe-training-schema first. Aggregate in SQL rather than returning thousands of rows.",
		}),
		inputSchema: runQuerySchema,
		outputSchema: trainingQueryResponse.outputSchema,
		annotations: readOnlyAnnotations("Run Training Query"),
		kind: "read" as const,
		responseContract: trainingQueryResponse,
		execute: async (runtime: ToolRuntime, args: RunQueryParams) => {
			try {
				const result = runQuery(runtime.getWarehouse().read, args.sql, {
					format: args.format,
					maxRows: args.maxRows,
				});
				return {
					rows: result.rows,
					rowCount: result.rowCount,
					columns: result.columns,
					truncated: result.truncated,
					format: result.format,
					formatted: result.formatted,
					...(result.notes ? { notes: result.notes } : {}),
				};
			} catch (error) {
				// A malformed or disallowed query is the caller's to fix, not a
				// server fault. Surface the real reason so the agent can correct
				// it; a generic failure just produces a blind retry.
				const reason = describeQueryFailure(error);
				if (reason === null) throw error;
				return {
					rows: [],
					rowCount: 0,
					columns: [],
					truncated: false,
					format: args.format,
					formatted: "",
					rejected: true,
					rejectionReason: reason,
				};
			}
		},
	},
	{
		name: "get-warehouse-status",
		feature: "warehouse" as const,
		operation: "get" as const,
		description: describeTool({
			summary:
				"Read-only. Reports what the local training warehouse contains and how current it is.",
			aliases: [
				"is my training data synced",
				"warehouse freshness",
				"how much history is local",
			],
			useCase:
				"Use to confirm coverage before trusting an analysis, or to decide whether to call sync-training-history first.",
			importantNotes:
				"staleDays counts days since the last successful sync, not since the last workout.",
		}),
		inputSchema: {},
		outputSchema: warehouseStatusResponse.outputSchema,
		annotations: readOnlyAnnotations("Get Warehouse Status"),
		kind: "read" as const,
		responseContract: warehouseStatusResponse,
		execute: async (runtime: ToolRuntime) => {
			const db = runtime.getWarehouse().read;
			const [stats] = db.all<{
				workouts: number;
				sets: number;
				firstDate: string | null;
				lastDate: string | null;
			}>(
				`SELECT
					(SELECT COUNT(*) FROM workout) AS workouts,
					(SELECT COUNT(*) FROM workout_set) AS sets,
					(SELECT MIN(local_date) FROM workout) AS firstDate,
					(SELECT MAX(local_date) FROM workout) AS lastDate`,
			);
			const [state] = db.all<{
				backfill_complete: number;
				last_event_sync_at: string | null;
			}>(
				"SELECT backfill_complete, last_event_sync_at FROM sync_state WHERE id = 1",
			);
			const [tz] = db.all<{ value: string }>(
				"SELECT value FROM meta WHERE key = 'timezone'",
			);
			return {
				configured: true,
				workouts: stats.workouts,
				sets: stats.sets,
				firstDate: stats.firstDate,
				lastDate: stats.lastDate,
				backfillComplete: Boolean(state?.backfill_complete),
				lastSyncedAt: state?.last_event_sync_at ?? null,
				timezone: tz?.value ?? null,
				staleDays: state?.last_event_sync_at
					? daysBetween(state.last_event_sync_at, new Date())
					: null,
			};
		},
	},
	{
		name: "sync-training-history",
		feature: "warehouse" as const,
		operation: "sync" as const,
		description: describeTool({
			summary:
				"Refreshes the local training warehouse from Hevy. Reads from Hevy only; it never modifies the Hevy account.",
			aliases: [
				"refresh my training data",
				"pull latest workouts",
				"update the warehouse",
			],
			useCase:
				"Use when get-warehouse-status shows stale data, or right after logging a workout. Not needed before every query.",
			importantNotes:
				"mode=auto applies only changes since the last sync and is fast. mode=full re-reads the entire history and can take a couple of minutes on a large account.",
		}),
		inputSchema: syncSchema,
		annotations: {
			title: "Sync Training History",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		kind: "write" as const,
		responseContract: warehouseSyncResponse,
		execute: async (runtime: ToolRuntime, args: SyncParams) => {
			const warehouse = runtime.getWarehouse();
			if (!warehouse.sync) {
				throw new Error(
					"This warehouse is read-only; syncing is disabled for this server.",
				);
			}
			return { mode: args.mode, details: await warehouse.sync(args.mode) };
		},
	},
] satisfies readonly ToolDefinition<Record<string, z.ZodTypeAny>, unknown>[];
