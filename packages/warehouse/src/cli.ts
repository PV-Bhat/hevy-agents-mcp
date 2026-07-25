#!/usr/bin/env node
/**
 * Warehouse sync CLI.
 *
 *   node --env-file=.env packages/warehouse/src/cli.ts probe
 *   node --env-file=.env packages/warehouse/src/cli.ts sync [--db path] [--tz zone]
 *   node packages/warehouse/src/cli.ts fractions
 *   node packages/warehouse/src/cli.ts set-fraction "Push Up" 0.7
 *   node packages/warehouse/src/cli.ts group "Bench" "Bench Press (Barbell)"
 *
 * `probe` makes a handful of read-only requests to confirm the key works,
 * report account size, and detect the real server-side page-size cap.
 * `sync` performs the full backfill, then keeps the local copy current.
 */
import { createNodeDriver } from "./node-driver.js";
import { createReadOnlyHttp } from "./read-only-http.js";
import { initSchema } from "./schema.js";
import {
	backfill,
	incremental,
	syncBodyMeasurements,
	syncTemplates,
} from "./sync.js";

function requireApiKey(): string {
	const key = process.env.HEVY_API_KEY?.trim();
	if (!key) {
		console.error(
			"HEVY_API_KEY is not set. Put it in .env and run with --env-file=.env",
		);
		process.exit(1);
	}
	return key;
}

function argValue(flag: string, fallback: string): string {
	const index = process.argv.indexOf(flag);
	return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function systemTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Detect the largest page size the server actually honors. */
async function detectPageSize(
	http: ReturnType<typeof createReadOnlyHttp>,
): Promise<number> {
	for (const candidate of [100, 50, 25, 10]) {
		try {
			const data = (await http.get("/v1/workouts", {
				page: 1,
				pageSize: candidate,
			})) as { workouts?: unknown[] };
			const returned = data?.workouts?.length ?? 0;
			// Server honored it only if it returned more than the next tier down.
			if (returned > 10) return candidate;
			if (candidate === 10) return 10;
		} catch {
			// 400 means the cap is lower; try the next candidate.
		}
	}
	return 10;
}

async function probe(): Promise<void> {
	const http = createReadOnlyHttp({ apiKey: requireApiKey() });
	console.log("Checking key against Hevy (read-only)...");

	const user = (await http.get("/v1/user/info")) as { username?: string };
	console.log(`  authenticated as: ${user?.username ?? "(unknown)"}`);

	const count = (await http.get("/v1/workouts/count")) as {
		workout_count?: number;
	};
	const total = count?.workout_count ?? 0;
	console.log(`  workouts in account: ${total}`);

	const pageSize = await detectPageSize(http);
	console.log(`  max page size honored: ${pageSize}`);
	console.log(
		`  estimated backfill: ~${Math.ceil(total / pageSize)} requests`,
	);
	console.log(`  timezone that will be used: ${systemTimezone()}`);
}

async function sync(): Promise<void> {
	const apiKey = requireApiKey();
	const dbPath = argValue("--db", "hevy-warehouse.db");
	const timezone = argValue("--tz", systemTimezone());
	const http = createReadOnlyHttp({ apiKey });
	const db = createNodeDriver(dbPath);

	try {
		initSchema(db);
		console.log(`database: ${dbPath}`);
		console.log(`timezone: ${timezone}`);

		const pageSize = await detectPageSize(http);
		console.log(`page size: ${pageSize}`);

		process.stdout.write("exercise templates... ");
		const templates = await syncTemplates(db, http);
		console.log(`${templates}`);

		const [state] = db.all<{ backfill_complete: number }>(
			"SELECT backfill_complete FROM sync_state WHERE id = 1",
		);

		if (state?.backfill_complete) {
			console.log("backfill already complete; applying changes since last sync");
			const result = await incremental(db, http, { timezone, pageSize });
			console.log(
				`  updated ${result.updated}, deleted ${result.deleted}`,
			);
		} else {
			console.log("backfilling full history...");
			const result = await backfill(db, http, {
				timezone,
				pageSize,
				onProgress: (done, total) => {
					process.stdout.write(
						`\r  ${done}${total ? `/${total}` : ""} workouts`,
					);
				},
			});
			console.log(`\n  imported ${result.workouts} workouts`);
		}

		process.stdout.write("body measurements... ");
		const measurements = await syncBodyMeasurements(db, http);
		console.log(`${measurements}`);

		const [summary] = db.all<{ workouts: number; sets: number }>(
			`SELECT
				(SELECT COUNT(*) FROM workout) AS workouts,
				(SELECT COUNT(*) FROM workout_set) AS sets`,
		);
		console.log(
			`\ndone: ${summary.workouts} workouts, ${summary.sets} sets stored`,
		);
	} finally {
		db.close();
	}
}

/** List the bodyweight fractions currently in effect. */
async function fractions(): Promise<void> {
	const db = createNodeDriver(argValue("--db", "hevy-warehouse.db"), {
		readOnly: true,
	});
	try {
		const rows = db.all<{ pattern: string; fraction: number }>(
			"SELECT pattern, fraction FROM bodyweight_fraction ORDER BY fraction DESC, pattern",
		);
		console.log(
			"Share of bodyweight each movement is modelled as loading.\n" +
				"Matched against the longest matching exercise-title prefix.\n",
		);
		for (const row of rows) {
			console.log(`  ${row.fraction.toFixed(2)}  ${row.pattern}`);
		}
		console.log(
			`\n${rows.length} entries. Change one with:\n` +
				'  cli.ts set-fraction "Push Up" 0.7\n' +
				"Movements with no entry contribute no volume when logged without weight.",
		);
	} finally {
		db.close();
	}
}

/** Set or add one bodyweight fraction. */
async function setFraction(): Promise<void> {
	const [, , , pattern, rawValue] = process.argv;
	const fraction = Number(rawValue);
	if (!pattern || !Number.isFinite(fraction)) {
		console.error('usage: cli.ts set-fraction "<title prefix>" <0-1.5>');
		process.exit(1);
	}
	if (fraction <= 0 || fraction > 1.5) {
		console.error("fraction must be greater than 0 and at most 1.5");
		process.exit(1);
	}
	const db = createNodeDriver(argValue("--db", "hevy-warehouse.db"));
	try {
		const [previous] = db.all<{ fraction: number }>(
			"SELECT fraction FROM bodyweight_fraction WHERE pattern = ?",
			[pattern],
		);
		db.run(
			"INSERT INTO bodyweight_fraction(pattern, fraction) VALUES (?,?) " +
				"ON CONFLICT(pattern) DO UPDATE SET fraction = excluded.fraction",
			[pattern, fraction],
		);
		console.log(
			previous
				? `updated "${pattern}": ${previous.fraction} -> ${fraction}`
				: `added "${pattern}": ${fraction}`,
		);
		const [affected] = db.all<{ sets: number }>(
			`SELECT COUNT(*) AS sets FROM workout_set ws
			 JOIN workout_exercise we
			   ON we.workout_id = ws.workout_id AND we.exercise_index = ws.exercise_index
			 WHERE COALESCE(we.title, '') LIKE ? || '%'`,
			[pattern],
		);
		console.log(
			`${affected.sets} logged sets match this prefix; volume recomputes on next server start.`,
		);
	} finally {
		db.close();
	}
}

/**
 * Group equivalent exercises so progression survives equipment changes.
 * Lives on the CLI rather than the MCP surface because the query tools are
 * deliberately read-only.
 */
async function group(): Promise<void> {
	const [, , , name, ...titles] = process.argv;
	const patterns = titles.filter((value) => !value.startsWith("--"));
	const db = createNodeDriver(argValue("--db", "hevy-warehouse.db"));
	try {
		if (!name) {
			const rows = db.all<{ name: string; titles: string }>(
				`SELECT g.name, GROUP_CONCAT(t.title, ' | ') AS titles
				 FROM exercise_group g
				 LEFT JOIN exercise_group_member m ON m.group_id = g.id
				 LEFT JOIN exercise_template t ON t.id = m.template_id
				 GROUP BY g.id ORDER BY g.name`,
			);
			if (rows.length === 0) {
				console.log(
					'No exercise groups defined. Create one with:\n  cli.ts group "Bench" "Bench Press (Barbell)" "Bench Press (Dumbbell)"',
				);
				return;
			}
			for (const row of rows) {
				console.log(`${row.name}: ${row.titles ?? "(empty)"}`);
			}
			return;
		}
		if (patterns.length === 0) {
			console.error(
				'usage: cli.ts group "<group name>" "<exercise title>" ["<exercise title>" ...]',
			);
			process.exit(1);
		}
		db.run("INSERT OR IGNORE INTO exercise_group(name) VALUES (?)", [name]);
		const [{ id }] = db.all<{ id: number }>(
			"SELECT id FROM exercise_group WHERE name = ?",
			[name],
		);
		let added = 0;
		for (const title of patterns) {
			const matches = db.all<{ id: string; title: string }>(
				"SELECT id, title FROM exercise_template WHERE title = ?",
				[title],
			);
			if (matches.length === 0) {
				console.error(`  no exercise template titled "${title}" — skipped`);
				continue;
			}
			for (const match of matches) {
				db.run(
					"INSERT OR IGNORE INTO exercise_group_member(group_id, template_id) VALUES (?,?)",
					[id, match.id],
				);
				console.log(`  + ${match.title}`);
				added++;
			}
		}
		console.log(
			`group "${name}": ${added} member(s). Query it by joining ` +
				"exercise_group_member on v_set.template_id.",
		);
	} finally {
		db.close();
	}
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
	probe,
	sync,
	fractions,
	"set-fraction": setFraction,
	group,
};
const run = commands[command ?? ""];

if (!run) {
	console.error(
		"usage: cli.ts <probe|sync|fractions|set-fraction|group> [--db path] [--tz zone]",
	);
	process.exit(1);
}

run().catch((error: unknown) => {
	console.error(`\nfailed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
