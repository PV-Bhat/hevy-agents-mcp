/**
 * Node-side warehouse wiring.
 *
 * Two handles are opened onto the same database file: a read-only one for
 * queries (SQLite itself then refuses writes, so no query can mutate
 * anything) and a writable one used only by sync. Sync reads from Hevy
 * through the GET-only HTTP client, so it cannot modify the Hevy account
 * either.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { WarehouseAccess } from "@hevy-mcp/core";
import {
	backfill,
	createNodeDriver,
	createReadOnlyHttp,
	incremental,
	initSchema,
	syncBodyMeasurements,
	syncTemplates,
	type SqlDriver,
} from "@hevy-mcp/warehouse";

export const WAREHOUSE_PATH_ENV = "HEVY_WAREHOUSE_DB";
export const WAREHOUSE_TZ_ENV = "HEVY_WAREHOUSE_TZ";

export function resolveWarehousePath(): string | undefined {
	const configured = process.env[WAREHOUSE_PATH_ENV]?.trim();
	return configured ? resolve(configured) : undefined;
}

function systemTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface OpenWarehouseOptions {
	path: string;
	apiKey: string;
	timezone?: string;
	/** Create and initialize the database if the file does not exist yet. */
	createIfMissing?: boolean;
}

export interface OpenedWarehouse extends WarehouseAccess {
	close(): void;
}

export function openWarehouse(
	options: OpenWarehouseOptions,
): OpenedWarehouse {
	const timezone = options.timezone ?? systemTimezone();
	const existed = existsSync(options.path);
	if (!existed && options.createIfMissing === false) {
		throw new Error(
			`No warehouse database at ${options.path}. Run the sync CLI first, or unset ${WAREHOUSE_PATH_ENV}.`,
		);
	}
	if (!existed) mkdirSync(dirname(options.path), { recursive: true });

	// The writable handle owns schema creation; views are refreshed on every
	// open so a definition change ships without a migration step.
	const write: SqlDriver = createNodeDriver(options.path);
	const [previousTz] = write.all<{ value: string }>(
		"SELECT value FROM meta WHERE key = 'timezone'",
	);
	initSchema(write, timezone);
	// A changed timezone would otherwise leave every historical local_date on
	// its old day, silently mixing two conventions in the same table.
	if (previousTz?.value && previousTz.value !== timezone) {
		const updated = recomputeLocalDates(write, timezone);
		console.error(
			`Warehouse timezone changed ${previousTz.value} -> ${timezone}; recomputed ${updated} workout dates.`,
		);
	}

	const read: SqlDriver = createNodeDriver(options.path, { readOnly: true });

	const http = createReadOnlyHttp({ apiKey: options.apiKey });

	return {
		read,
		write,
		async sync(mode) {
			const details: Record<string, unknown> = { timezone };
			details.templates = await syncTemplates(write, http);

			const [state] = write.all<{ backfill_complete: number }>(
				"SELECT backfill_complete FROM sync_state WHERE id = 1",
			);
			const needsBackfill = mode === "full" || !state?.backfill_complete;

			if (mode === "full") {
				// Re-read everything: clear the resume pointer and completion flag.
				write.run(
					"UPDATE sync_state SET backfill_complete = 0, last_backfill_page = NULL WHERE id = 1",
				);
			}

			if (needsBackfill) {
				const result = await backfill(write, http, {
					timezone,
					// A full pass is authoritative and must remove local workouts
					// Hevy no longer has. An initial backfill has nothing to
					// reconcile against, so the extra bookkeeping is skipped.
					reconcileDeletes: mode === "full",
				});
				details.backfill = result;
			} else {
				const result = await incremental(write, http, { timezone });
				details.incremental = result;
			}

			details.bodyMeasurements = await syncBodyMeasurements(write, http);
			const [totals] = write.all<{ workouts: number; sets: number }>(
				`SELECT (SELECT COUNT(*) FROM workout) AS workouts,
				        (SELECT COUNT(*) FROM workout_set) AS sets`,
			);
			details.totals = totals;
			return details;
		},
		close() {
			read.close();
			write.close();
		},
	};
}
