import { describe, expect, it } from "vitest";
import { createNodeDriver } from "./node-driver.js";
import { initSchema } from "./schema.js";
import {
	backfill,
	deleteWorkout,
	incremental,
	localDateOf,
	recomputeLocalDates,
	upsertWorkout,
} from "./sync.js";
import type { ReadOnlyHttp } from "./read-only-http.js";
import type { SqlDriver } from "./driver.js";

function memoryDb(): SqlDriver {
	const db = createNodeDriver(":memory:");
	initSchema(db);
	return db;
}

function workoutFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "w1",
		title: "Push Day",
		start_time: "2026-03-01T18:30:00Z",
		end_time: "2026-03-01T19:45:00Z",
		updated_at: "2026-03-01T19:45:00Z",
		exercises: [
			{
				index: 0,
				title: "Bench Press (Barbell)",
				exercise_template_id: "TPL1",
				sets: [
					{ index: 0, type: "warmup", weight_kg: 40, reps: 10 },
					{ index: 1, type: "normal", weight_kg: 80, reps: 8, rpe: 8 },
					{ index: 2, type: "normal", weight_kg: 80, reps: 7 },
				],
			},
		],
		...overrides,
	};
}

/** Minimal fake that serves canned pages; records calls for assertions. */
function fakeHttp(routes: Record<string, unknown[]>): ReadOnlyHttp & {
	calls: string[];
} {
	const calls: string[] = [];
	const cursors: Record<string, number> = {};
	return {
		calls,
		async get(path, query = {}) {
			calls.push(`${path}?${new URLSearchParams(
				Object.entries(query).map(([k, v]) => [k, String(v)]),
			)}`);
			const pages = routes[path];
			if (!pages) throw new Error(`unexpected path ${path}`);
			const index = cursors[path] ?? 0;
			cursors[path] = index + 1;
			return pages[index] ?? pages.at(-1);
		},
	};
}

describe("localDateOf", () => {
	it("uses the configured timezone, not UTC", () => {
		// 22:30 UTC on Mar 1 is already Mar 2 in Kolkata (+05:30).
		expect(localDateOf("2026-03-01T22:30:00Z", "Asia/Kolkata")).toBe(
			"2026-03-02",
		);
		expect(localDateOf("2026-03-01T22:30:00Z", "UTC")).toBe("2026-03-01");
	});

	it("returns null for missing or invalid instants", () => {
		expect(localDateOf(undefined, "UTC")).toBeNull();
		expect(localDateOf("not-a-date", "UTC")).toBeNull();
	});
});

describe("upsertWorkout", () => {
	it("stores workout, exercises and sets", () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture(), "UTC");
		expect(db.all("SELECT * FROM workout")).toHaveLength(1);
		expect(db.all("SELECT * FROM workout_exercise")).toHaveLength(1);
		expect(db.all("SELECT * FROM workout_set")).toHaveLength(3);
		const [w] = db.all<{ duration_seconds: number; local_date: string }>(
			"SELECT duration_seconds, local_date FROM workout",
		);
		expect(w.duration_seconds).toBe(75 * 60);
		expect(w.local_date).toBe("2026-03-01");
	});

	it("is idempotent — re-syncing the same workout does not duplicate rows", () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture(), "UTC");
		upsertWorkout(db, workoutFixture(), "UTC");
		expect(db.all("SELECT * FROM workout")).toHaveLength(1);
		expect(db.all("SELECT * FROM workout_set")).toHaveLength(3);
	});

	it("shrinks child rows when an edit removes sets", () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture(), "UTC");
		const edited = workoutFixture({
			exercises: [
				{
					index: 0,
					title: "Bench Press (Barbell)",
					exercise_template_id: "TPL1",
					sets: [{ index: 0, type: "normal", weight_kg: 85, reps: 5 }],
				},
			],
		});
		upsertWorkout(db, edited, "UTC");
		expect(db.all("SELECT * FROM workout_set")).toHaveLength(1);
	});

	it("preserves raw json so derived rows can be rebuilt without re-downloading", () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture(), "UTC");
		const [{ raw_json }] = db.all<{ raw_json: string }>(
			"SELECT raw_json FROM workout",
		);
		expect(JSON.parse(raw_json).title).toBe("Push Day");
	});
});

describe("v_working_set view", () => {
	it("excludes warmup sets", () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture(), "UTC");
		const rows = db.all("SELECT * FROM v_working_set");
		expect(rows).toHaveLength(2);
	});
});

describe("deleteWorkout", () => {
	it("removes the workout and its children", () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture(), "UTC");
		deleteWorkout(db, "w1");
		expect(db.all("SELECT * FROM workout")).toHaveLength(0);
		expect(db.all("SELECT * FROM workout_set")).toHaveLength(0);
	});
});

describe("backfill", () => {
	it("pages through history and marks completion", async () => {
		const db = memoryDb();
		const http = fakeHttp({
			"/v1/workouts/count": [{ workout_count: 3 }],
			"/v1/workouts": [
				{ workouts: [workoutFixture({ id: "w1" })], page_count: 2 },
				{ workouts: [workoutFixture({ id: "w2" })], page_count: 2 },
			],
		});
		const result = await backfill(db, http, { timezone: "UTC", pageSize: 1 });
		expect(result.workouts).toBe(2);
		expect(db.all("SELECT * FROM workout")).toHaveLength(2);
		const [state] = db.all<{
			backfill_complete: number;
			last_event_sync_at: string | null;
		}>("SELECT backfill_complete, last_event_sync_at FROM sync_state");
		expect(state.backfill_complete).toBe(1);
		// Anchor must be set so the first incremental pass has a starting point.
		expect(state.last_event_sync_at).toBeTruthy();
	});

	it("resumes from the last completed page after an interruption", async () => {
		const db = memoryDb();
		db.run("UPDATE sync_state SET last_backfill_page = 1 WHERE id = 1");
		const http = fakeHttp({
			"/v1/workouts/count": [{ workout_count: 2 }],
			"/v1/workouts": [
				{ workouts: [workoutFixture({ id: "w2" })], page_count: 2 },
			],
		});
		await backfill(db, http, { timezone: "UTC", pageSize: 1 });
		// Requested page 2, not page 1.
		expect(http.calls.some((c) => c.includes("page=2"))).toBe(true);
		expect(http.calls.some((c) => c.includes("page=1"))).toBe(false);
	});
});

describe("incremental", () => {
	it("applies updates and honors deletes", async () => {
		const db = memoryDb();
		upsertWorkout(db, workoutFixture({ id: "w1" }), "UTC");
		upsertWorkout(db, workoutFixture({ id: "w2" }), "UTC");
		const http = fakeHttp({
			"/v1/workouts/events": [
				{
					events: [
						{ type: "deleted", id: "w1" },
						{
							type: "updated",
							workout: workoutFixture({ id: "w2", title: "Renamed" }),
						},
					],
					page_count: 1,
				},
			],
		});
		const result = await incremental(db, http, { timezone: "UTC" });
		expect(result.deleted).toBe(1);
		expect(result.updated).toBe(1);
		const rows = db.all<{ id: string; title: string }>(
			"SELECT id, title FROM workout",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: "w2", title: "Renamed" });
	});

	it("advances the sync cursor", async () => {
		const db = memoryDb();
		const http = fakeHttp({
			"/v1/workouts/events": [{ events: [], page_count: 1 }],
		});
		await incremental(db, http, { timezone: "UTC" });
		const [state] = db.all<{ last_event_sync_at: string }>(
			"SELECT last_event_sync_at FROM sync_state",
		);
		expect(state.last_event_sync_at).toBeTruthy();
	});
});

describe("full-sync delete reconciliation", () => {
	function workout(id: string, date: string) {
		return {
			id,
			title: `Session ${id}`,
			start_time: `${date}T10:00:00Z`,
			end_time: `${date}T11:00:00Z`,
			exercises: [
				{
					index: 0,
					exercise_template_id: "T",
					title: "Row",
					sets: [{ index: 0, type: "normal", weight_kg: 60, reps: 10 }],
				},
			],
		};
	}

	function stubHttp(workouts: ReturnType<typeof workout>[]) {
		return {
			get: async (path: string, query: Record<string, string | number> = {}) => {
				if (path === "/v1/workouts/count")
					return { workout_count: workouts.length };
				if (path === "/v1/workouts") {
					const pageSize = Number(query.pageSize ?? 10);
					const page = Number(query.page ?? 1);
					const slice = workouts.slice((page - 1) * pageSize, page * pageSize);
					return {
						workouts: slice,
						page_count: Math.max(1, Math.ceil(workouts.length / pageSize)),
					};
				}
				return {};
			},
		};
	}

	async function seededDb() {
		const db = createNodeDriver(":memory:");
		initSchema(db, "UTC");
		await backfill(
			db,
			stubHttp([
				workout("a", "2026-01-01"),
				workout("b", "2026-01-02"),
				workout("c", "2026-01-03"),
			]),
			{ timezone: "UTC" },
		);
		return db;
	}

	it("imports the initial history", async () => {
		const db = await seededDb();
		expect(db.all<{ n: number }>("SELECT COUNT(*) n FROM workout")[0].n).toBe(3);
	});

	// Deletions otherwise arrive only via the events feed. A rebuild after a
	// missed-events window would leave ghost workouts and permanently inflate
	// every lifetime total.
	it("removes workouts Hevy no longer has when reconciling", async () => {
		const db = await seededDb();
		db.run(
			"UPDATE sync_state SET backfill_complete = 0, last_backfill_page = NULL WHERE id = 1",
		);
		const result = await backfill(
			db,
			stubHttp([workout("a", "2026-01-01"), workout("c", "2026-01-03")]),
			{ timezone: "UTC", reconcileDeletes: true },
		);
		expect(result.removed).toBe(1);
		const ids = db
			.all<{ id: string }>("SELECT id FROM workout ORDER BY id")
			.map((r) => r.id);
		expect(ids).toEqual(["a", "c"]);
	});

	it("cascades child rows when reconciling removes a workout", async () => {
		const db = await seededDb();
		db.run(
			"UPDATE sync_state SET backfill_complete = 0, last_backfill_page = NULL WHERE id = 1",
		);
		await backfill(db, stubHttp([workout("a", "2026-01-01")]), {
			timezone: "UTC",
			reconcileDeletes: true,
		});
		expect(
			db.all<{ n: number }>("SELECT COUNT(*) n FROM workout_set")[0].n,
		).toBe(1);
		expect(
			db.all<{ n: number }>(
				"SELECT COUNT(*) n FROM workout_exercise WHERE workout_id <> 'a'",
			)[0].n,
		).toBe(0);
	});

	it("leaves local data alone when not reconciling", async () => {
		const db = await seededDb();
		db.run(
			"UPDATE sync_state SET backfill_complete = 0, last_backfill_page = NULL WHERE id = 1",
		);
		const result = await backfill(db, stubHttp([workout("a", "2026-01-01")]), {
			timezone: "UTC",
		});
		expect(result.removed).toBe(0);
		expect(db.all<{ n: number }>("SELECT COUNT(*) n FROM workout")[0].n).toBe(3);
	});

	it("drops its staging table afterwards", async () => {
		const db = await seededDb();
		db.run(
			"UPDATE sync_state SET backfill_complete = 0, last_backfill_page = NULL WHERE id = 1",
		);
		await backfill(db, stubHttp([workout("a", "2026-01-01")]), {
			timezone: "UTC",
			reconcileDeletes: true,
		});
		const tables = db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='sync_seen'",
		);
		expect(tables).toEqual([]);
	});
});

describe("recomputeLocalDates", () => {
	// A changed timezone must not leave historical rows on their old day, or
	// daily and weekly grouping silently mixes two conventions.
	it("moves a late-evening session to the correct local day", () => {
		const db = createNodeDriver(":memory:");
		initSchema(db, "UTC");
		upsertWorkout(
			db,
			{
				id: "late",
				start_time: "2026-03-01T23:30:00Z",
				end_time: "2026-03-02T00:30:00Z",
				exercises: [],
			},
			"UTC",
		);
		expect(
			db.all<{ local_date: string }>("SELECT local_date FROM workout")[0]
				.local_date,
		).toBe("2026-03-01");

		const updated = recomputeLocalDates(db, "Asia/Tokyo");
		expect(updated).toBe(1);
		expect(
			db.all<{ local_date: string }>("SELECT local_date FROM workout")[0]
				.local_date,
		).toBe("2026-03-02");
	});
});
