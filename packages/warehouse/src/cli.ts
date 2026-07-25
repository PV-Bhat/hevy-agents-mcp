#!/usr/bin/env node
/**
 * Warehouse sync CLI.
 *
 *   node --env-file=.env packages/warehouse/src/cli.ts probe
 *   node --env-file=.env packages/warehouse/src/cli.ts sync [--db path] [--tz zone]
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

const command = process.argv[2];
const run = command === "probe" ? probe : command === "sync" ? sync : null;

if (!run) {
	console.error("usage: cli.ts <probe|sync> [--db path] [--tz zone]");
	process.exit(1);
}

run().catch((error: unknown) => {
	console.error(`\nfailed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
