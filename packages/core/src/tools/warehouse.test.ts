import { describe, expect, it } from "vitest";
import {
	createNodeDriver,
	initSchema,
	upsertWorkout,
	type SqlDriver,
} from "@hevy-mcp/warehouse";
import { warehouseToolDefinitions } from "./warehouse.js";
import type { ToolRuntime, WarehouseAccess } from "./tool-runtime.js";

function seededWarehouse(): SqlDriver {
	const db = createNodeDriver(":memory:");
	initSchema(db, "Europe/Copenhagen");
	db.run(
		`INSERT INTO exercise_template
			(id, title, exercise_type, equipment_category, primary_muscle_group, is_custom, raw_json)
		 VALUES ('T1','Bench Press (Barbell)','weight_reps','barbell','chest',0,'{}')`,
	);
	upsertWorkout(
		db,
		{
			id: "w1",
			title: "Push",
			start_time: "2026-03-01T10:00:00Z",
			end_time: "2026-03-01T11:00:00Z",
			exercises: [
				{
					index: 0,
					exercise_template_id: "T1",
					title: "Bench Press (Barbell)",
					sets: [{ index: 0, type: "normal", weight_kg: 100, reps: 5 }],
				},
			],
		},
		"Europe/Copenhagen",
	);
	return db;
}

function runtimeWith(warehouse: WarehouseAccess | undefined): ToolRuntime {
	return {
		client: null,
		catalog: { get: async () => [], reset: () => {} },
		createHandler: ((fn: unknown) => fn) as ToolRuntime["createHandler"],
		warehouse,
		getClient: () => {
			throw new Error("not used");
		},
		getWarehouse: () => {
			if (!warehouse) throw new Error("no warehouse");
			return warehouse;
		},
	} as ToolRuntime;
}

function tool(name: string) {
	const found = warehouseToolDefinitions.find((t) => t.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
}

describe("warehouse tool definitions", () => {
	it("exposes the four warehouse tools", () => {
		expect(warehouseToolDefinitions.map((t) => t.name)).toEqual([
			"describe-training-schema",
			"run-training-query",
			"get-warehouse-status",
			"sync-training-history",
		]);
	});

	it("marks query tools read-only and sync non-destructive", () => {
		expect(tool("run-training-query").annotations.readOnlyHint).toBe(true);
		expect(tool("describe-training-schema").annotations.readOnlyHint).toBe(
			true,
		);
		expect(tool("sync-training-history").annotations.destructiveHint).toBe(
			false,
		);
	});
});

describe("run-training-query", () => {
	const runQueryTool = tool("run-training-query");

	async function run(sql: string, extra: Record<string, unknown> = {}) {
		const db = seededWarehouse();
		return (await runQueryTool.execute(runtimeWith({ read: db }), {
			sql,
			format: "json",
			maxRows: 500,
			...extra,
		} as never)) as {
			rowCount: number;
			rejected?: boolean;
			rejectionReason?: string;
			rows: Record<string, unknown>[];
		};
	}

	it("returns rows for a valid query", async () => {
		const result = await run("SELECT exercise_title, volume_kg FROM v_set");
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]).toMatchObject({
			exercise_title: "Bench Press (Barbell)",
			volume_kg: 500,
		});
	});

	// A rejected query is the caller's to fix. It must come back as a normal
	// result carrying the reason, not as an opaque server failure, or the
	// agent has nothing to correct against.
	it("reports a disallowed statement with an actionable reason", async () => {
		const result = await run("DELETE FROM workout");
		expect(result.rejected).toBe(true);
		expect(result.rejectionReason).toContain("only SELECT and WITH");
		expect(result.rowCount).toBe(0);
	});

	it("passes SQLite's own error through for a bad column", async () => {
		const result = await run("SELECT nonexistent_column FROM v_set");
		expect(result.rejected).toBe(true);
		expect(result.rejectionReason).toContain("no such column");
		expect(result.rejectionReason).toContain("describe-training-schema");
	});

	it("rejects stacked statements", async () => {
		const result = await run("SELECT 1; DROP TABLE workout");
		expect(result.rejected).toBe(true);
	});
});

describe("get-warehouse-status", () => {
	it("reports not configured when no warehouse is attached", async () => {
		const result = (await tool("get-warehouse-status").execute(
			runtimeWith(undefined),
			{} as never,
		)) as { configured: boolean };
		expect(result.configured).toBe(false);
	});

	it("reports coverage when a warehouse is attached", async () => {
		const db = seededWarehouse();
		const result = (await tool("get-warehouse-status").execute(
			runtimeWith({ read: db }),
			{} as never,
		)) as { configured: boolean; workouts: number; timezone: string };
		expect(result).toMatchObject({
			configured: true,
			workouts: 1,
			timezone: "Europe/Copenhagen",
		});
	});
});

describe("sync-training-history", () => {
	it("fails clearly when the warehouse cannot sync", async () => {
		const db = seededWarehouse();
		await expect(
			tool("sync-training-history").execute(runtimeWith({ read: db }), {
				mode: "auto",
			} as never),
		).rejects.toThrow(/read-only/);
	});

	it("delegates to the warehouse sync implementation", async () => {
		const db = seededWarehouse();
		const result = (await tool("sync-training-history").execute(
			runtimeWith({
				read: db,
				sync: async (mode) => ({ ranWith: mode }),
			}),
			{ mode: "full" } as never,
		)) as { mode: string; details: Record<string, unknown> };
		expect(result.mode).toBe("full");
		expect(result.details).toEqual({ ranWith: "full" });
	});
});

describe("describe-training-schema", () => {
	it("returns a schema description that names the key views", async () => {
		const db = seededWarehouse();
		const text = (await tool("describe-training-schema").execute(
			runtimeWith({ read: db }),
			{} as never,
		)) as string;
		expect(text).toContain("v_set");
		expect(text).toContain("CONVENTIONS");
		expect(text).toContain("CAVEATS");
		// The modeling assumptions must be stated, not implied.
		expect(text).toContain("volume_basis");
	});
});
