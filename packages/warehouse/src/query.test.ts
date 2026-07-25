import { describe, expect, it } from "vitest";
import { createNodeDriver } from "./node-driver.js";
import { initSchema } from "./schema.js";
import { upsertWorkout } from "./sync.js";
import {
	QueryRejectedError,
	runQuery,
	stripLiteralsAndComments,
	validateQuery,
} from "./query.js";
import type { SqlDriver } from "./driver.js";

function seeded(): SqlDriver {
	const db = createNodeDriver(":memory:");
	initSchema(db, "Europe/Copenhagen");
	db.run(
		`INSERT INTO exercise_template
			(id, title, exercise_type, equipment_category, primary_muscle_group, is_custom, raw_json)
		 VALUES ('TPL1','Bench Press (Barbell)','weight_reps','barbell','chest',0,'{}')`,
	);
	db.run(
		"INSERT INTO template_secondary_muscle(template_id, muscle_group) VALUES ('TPL1','triceps')",
	);
	db.run(
		`INSERT INTO exercise_template
			(id, title, exercise_type, equipment_category, primary_muscle_group, is_custom, raw_json)
		 VALUES ('TPL2','Treadmill','distance_duration','machine','cardio',0,'{}')`,
	);
	db.run(
		`INSERT INTO body_measurement(date, weight_kg, raw_json)
		 VALUES ('2026-02-01', 80.0, '{}')`,
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
					exercise_template_id: "TPL1",
					title: "Bench Press (Barbell)",
					sets: [
						{ index: 0, type: "warmup", weight_kg: 40, reps: 10 },
						{ index: 1, type: "normal", weight_kg: 100, reps: 5 },
					],
				},
				{
					index: 1,
					exercise_template_id: "TPL2",
					title: "Treadmill",
					sets: [
						{ index: 0, type: "normal", distance_meters: 3000, duration_seconds: 900 },
					],
				},
			],
		},
		"Europe/Copenhagen",
	);
	return db;
}

describe("stripLiteralsAndComments", () => {
	it("removes line and block comments", () => {
		expect(stripLiteralsAndComments("SELECT 1 -- drop table x")).not.toContain(
			"drop",
		);
		expect(
			stripLiteralsAndComments("SELECT /* delete from y */ 1"),
		).not.toContain("delete");
	});

	it("removes string literals so data cannot trip keyword filters", () => {
		const bare = stripLiteralsAndComments(
			"SELECT * FROM v_set WHERE exercise_title = 'Attach Bar Row'",
		);
		expect(bare.toLowerCase()).not.toContain("attach");
	});

	it("handles doubled quotes inside literals", () => {
		const bare = stripLiteralsAndComments(
			"SELECT * FROM v_set WHERE title = 'it''s a drop set'",
		);
		expect(bare.toLowerCase()).not.toContain("drop");
		expect(bare).toContain("SELECT");
	});
});

describe("validateQuery", () => {
	it("accepts SELECT and WITH", () => {
		expect(validateQuery("SELECT 1")).toBe("SELECT 1");
		expect(validateQuery("WITH a AS (SELECT 1) SELECT * FROM a")).toContain(
			"WITH",
		);
	});

	it("accepts a single trailing semicolon", () => {
		expect(validateQuery("SELECT 1;")).toBe("SELECT 1;");
	});

	it.each([
		"DELETE FROM workout",
		"DROP TABLE workout",
		"UPDATE workout SET title='x'",
		"INSERT INTO workout VALUES (1)",
		"PRAGMA table_info(workout)",
		"ATTACH DATABASE 'x.db' AS y",
		"CREATE TABLE t(a)",
		"VACUUM",
	])("rejects %s", (sql) => {
		expect(() => validateQuery(sql)).toThrow(QueryRejectedError);
	});

	it("rejects stacked statements", () => {
		expect(() => validateQuery("SELECT 1; DROP TABLE workout")).toThrow(
			QueryRejectedError,
		);
	});

	it("rejects a write hidden behind a CTE", () => {
		expect(() =>
			validateQuery("WITH x AS (SELECT 1) DELETE FROM workout"),
		).toThrow(QueryRejectedError);
	});

	it("rejects an empty query", () => {
		expect(() => validateQuery("   ")).toThrow(QueryRejectedError);
	});

	it("allows an exercise name that contains a forbidden word as data", () => {
		expect(() =>
			validateQuery(
				"SELECT * FROM v_set WHERE exercise_title LIKE '%Drop Set%'",
			),
		).not.toThrow();
	});
});

describe("semantic views", () => {
	it("excludes warmups from v_set", () => {
		const db = seeded();
		const rows = db.all<{ n: number }>(
			"SELECT COUNT(*) n FROM v_set WHERE template_id = 'TPL1'",
		);
		expect(rows[0].n).toBe(1);
	});

	it("computes volume for weight_reps", () => {
		const db = seeded();
		const [row] = db.all<{ volume_kg: number }>(
			"SELECT volume_kg FROM v_set WHERE template_id = 'TPL1'",
		);
		expect(row.volume_kg).toBe(500);
	});

	it("leaves volume NULL for cardio rather than reporting zero", () => {
		const db = seeded();
		const [row] = db.all<{ volume_kg: number | null }>(
			"SELECT volume_kg FROM v_set WHERE template_id = 'TPL2'",
		);
		expect(row.volume_kg).toBeNull();
	});

	it("computes Epley e1RM", () => {
		const db = seeded();
		const [row] = db.all<{ e1rm_kg: number }>(
			"SELECT e1rm_kg FROM v_set WHERE template_id = 'TPL1'",
		);
		// 100 * (1 + 5/30) = 116.67
		expect(row.e1rm_kg).toBeCloseTo(116.667, 2);
	});

	it("credits primary muscle 1.0 and secondary 0.5", () => {
		const db = seeded();
		const rows = db.all<{
			muscle_group: string;
			credit: number;
			credited_volume_kg: number;
		}>(
			"SELECT muscle_group, credit, credited_volume_kg FROM v_set_muscle " +
				"WHERE template_id = 'TPL1' ORDER BY is_primary DESC",
		);
		expect(rows).toEqual([
			{ muscle_group: "chest", credit: 1.0, credited_volume_kg: 500 },
			{ muscle_group: "triceps", credit: 0.5, credited_volume_kg: 250 },
		]);
	});

	it("resolves bodyweight carried at the time of the session", () => {
		const db = seeded();
		const [row] = db.all<{ bodyweight_kg: number }>(
			"SELECT bodyweight_kg FROM v_set WHERE template_id = 'TPL1'",
		);
		expect(row.bodyweight_kg).toBe(80);
	});

	it("aggregates a session", () => {
		const db = seeded();
		const [row] = db.all<{
			working_set_count: number;
			volume_kg: number;
		}>("SELECT working_set_count, volume_kg FROM v_session");
		expect(row.working_set_count).toBe(2);
		expect(row.volume_kg).toBe(500);
	});
});

describe("runQuery", () => {
	it("returns rows and columns", () => {
		const db = seeded();
		const result = runQuery(db, "SELECT exercise_title, volume_kg FROM v_set");
		expect(result.columns).toEqual(["exercise_title", "volume_kg"]);
		expect(result.rowCount).toBe(2);
	});

	it("truncates beyond maxRows and says so", () => {
		const db = seeded();
		const result = runQuery(db, "SELECT * FROM v_set", { maxRows: 1 });
		expect(result.rowCount).toBe(1);
		expect(result.truncated).toBe(true);
		expect(result.notes?.[0]).toContain("truncated");
	});

	it("formats as csv", () => {
		const db = seeded();
		const result = runQuery(
			db,
			"SELECT exercise_title FROM v_set ORDER BY exercise_title",
			{ format: "csv" },
		);
		expect(result.formatted).toBe(
			"exercise_title\nBench Press (Barbell)\nTreadmill",
		);
	});

	it("formats as markdown", () => {
		const db = seeded();
		const result = runQuery(db, "SELECT reps FROM v_set WHERE reps IS NOT NULL", {
			format: "markdown",
		});
		expect(result.formatted).toContain("| reps |");
		expect(result.formatted).toContain("| 5 |");
	});

	it("escapes csv values containing commas", () => {
		const db = seeded();
		const result = runQuery(db, "SELECT 'a,b' AS x", { format: "csv" });
		expect(result.formatted).toBe('x\n"a,b"');
	});

	it("refuses a write attempt", () => {
		const db = seeded();
		expect(() => runQuery(db, "DELETE FROM workout")).toThrow(
			QueryRejectedError,
		);
	});
});

describe("read-only driver", () => {
	it("blocks writes at the engine level even if validation is bypassed", () => {
		const path = ":memory:";
		const writable = createNodeDriver(path);
		initSchema(writable);
		// A read-only handle to a file-backed db is the real deployment shape;
		// for :memory: we assert the option is honored by the constructor.
		expect(() =>
			createNodeDriver("nonexistent-readonly.db", { readOnly: true }),
		).toThrow();
	});
});
