import type { SqlDriver } from "./driver.js";
import type { ReadOnlyHttp } from "./read-only-http.js";

/**
 * Sync engine. Two modes:
 *  - backfill(): one-time full download, resumable if interrupted.
 *  - incremental(): applies the /v1/workouts/events feed (updates AND
 *    deletes) since the last sync. Deletes are honored — an upsert-only
 *    sync would drift lifetime totals upward forever.
 */

export interface SyncOptions {
	/** IANA timezone for local_date derivation, e.g. "Asia/Kolkata". */
	timezone: string;
	/** Workouts per request. API default caps at 10; probed at runtime. */
	pageSize?: number;
	onProgress?: (done: number, total: number | undefined) => void;
}

interface WorkoutJson {
	id?: string;
	title?: string;
	description?: string;
	start_time?: string;
	end_time?: string;
	updated_at?: string;
	created_at?: string;
	exercises?: ExerciseJson[];
}

interface ExerciseJson {
	index?: number;
	title?: string;
	notes?: string;
	exercise_template_id?: string;
	supersets_id?: number | null;
	sets?: SetJson[];
}

interface SetJson {
	index?: number;
	type?: string;
	weight_kg?: number | null;
	reps?: number | null;
	distance_meters?: number | null;
	duration_seconds?: number | null;
	rpe?: number | null;
	custom_metric?: number | null;
}

export function localDateOf(
	utcInstant: string | undefined,
	timezone: string,
): string | null {
	if (!utcInstant) return null;
	const ms = Date.parse(utcInstant);
	if (!Number.isFinite(ms)) return null;
	// en-CA renders as YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(ms));
}

function durationSecondsOf(w: WorkoutJson): number | null {
	if (!w.start_time || !w.end_time) return null;
	const d = Date.parse(w.end_time) - Date.parse(w.start_time);
	return Number.isFinite(d) && d >= 0 ? Math.floor(d / 1000) : null;
}

/** Upsert one workout and all its child rows atomically. */
export function upsertWorkout(
	db: SqlDriver,
	workout: WorkoutJson,
	timezone: string,
): void {
	if (!workout.id) return;
	const id = workout.id;
	db.transaction(() => {
		// Children are replaced wholesale: set counts can shrink on edit.
		db.run("DELETE FROM workout_exercise WHERE workout_id = ?", [id]);
		db.run(
			`INSERT INTO workout
				(id, title, description, start_time, end_time, local_date,
				 duration_seconds, updated_at, created_at, raw_json)
			 VALUES (?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(id) DO UPDATE SET
				title=excluded.title, description=excluded.description,
				start_time=excluded.start_time, end_time=excluded.end_time,
				local_date=excluded.local_date,
				duration_seconds=excluded.duration_seconds,
				updated_at=excluded.updated_at, created_at=excluded.created_at,
				raw_json=excluded.raw_json`,
			[
				id,
				workout.title ?? null,
				workout.description ?? null,
				workout.start_time ?? null,
				workout.end_time ?? null,
				localDateOf(workout.start_time, timezone),
				durationSecondsOf(workout),
				workout.updated_at ?? null,
				workout.created_at ?? null,
				JSON.stringify(workout),
			],
		);
		for (const [i, exercise] of (workout.exercises ?? []).entries()) {
			const exerciseIndex = exercise.index ?? i;
			db.run(
				`INSERT INTO workout_exercise
					(workout_id, exercise_index, template_id, title, notes, superset_id)
				 VALUES (?,?,?,?,?,?)`,
				[
					id,
					exerciseIndex,
					exercise.exercise_template_id ?? null,
					exercise.title ?? null,
					exercise.notes ?? null,
					exercise.supersets_id ?? null,
				],
			);
			for (const [j, set] of (exercise.sets ?? []).entries()) {
				db.run(
					`INSERT INTO workout_set
						(workout_id, exercise_index, set_index, set_type, weight_kg,
						 reps, distance_meters, duration_seconds, rpe, custom_metric)
					 VALUES (?,?,?,?,?,?,?,?,?,?)`,
					[
						id,
						exerciseIndex,
						set.index ?? j,
						set.type ?? null,
						set.weight_kg ?? null,
						set.reps ?? null,
						set.distance_meters ?? null,
						set.duration_seconds ?? null,
						set.rpe ?? null,
						set.custom_metric ?? null,
					],
				);
			}
		}
	});
}

/**
 * Recompute local_date for every stored workout under a new timezone.
 *
 * Without this, changing the timezone updates the recorded setting but
 * leaves every historical local_date on its old day, so weekly and daily
 * grouping silently mixes two conventions. Runs off the stored UTC instant,
 * so no re-download is needed.
 */
export function recomputeLocalDates(db: SqlDriver, timezone: string): number {
	const rows = db.all<{ id: string; start_time: string | null }>(
		"SELECT id, start_time FROM workout",
	);
	let updated = 0;
	db.transaction(() => {
		for (const row of rows) {
			const localDate = localDateOf(row.start_time ?? undefined, timezone);
			db.run("UPDATE workout SET local_date = ? WHERE id = ?", [
				localDate,
				row.id,
			]);
			updated++;
		}
	});
	return updated;
}

export function deleteWorkout(db: SqlDriver, workoutId: string): void {
	db.transaction(() => {
		db.run("DELETE FROM workout_exercise WHERE workout_id = ?", [workoutId]);
		db.run("DELETE FROM workout WHERE id = ?", [workoutId]);
	});
}

export interface BackfillOptions extends SyncOptions {
	/**
	 * Treat the download as authoritative: any local workout not seen during
	 * this pass is deleted. Required for a full re-sync, because deletions
	 * otherwise only arrive through the events feed — so a rebuild after a
	 * missed-events window would leave ghost workouts and permanently
	 * inflated lifetime totals.
	 */
	reconcileDeletes?: boolean;
}

/** Full one-time download. Resumable: restarts from last completed page. */
export async function backfill(
	db: SqlDriver,
	http: ReadOnlyHttp,
	options: BackfillOptions,
): Promise<{ workouts: number; pages: number; removed: number }> {
	const pageSize = options.pageSize ?? 10;
	// Anchor the incremental feed BEFORE downloading, so edits made during
	// a long backfill are picked up by the first incremental pass.
	const syncAnchor = new Date().toISOString();

	const countData = (await http.get("/v1/workouts/count")) as {
		workout_count?: number;
	};
	const total = countData?.workout_count;

	const resume = db.all<{ last_backfill_page: number | null }>(
		"SELECT last_backfill_page FROM sync_state WHERE id = 1",
	)[0];
	let page = (resume?.last_backfill_page ?? 0) + 1;
	let imported = 0;

	if (options.reconcileDeletes) {
		// Staging table rather than an in-memory id list: a reconcile pass is
		// resumable across interrupted runs and does not grow the heap with
		// the account size.
		db.exec(
			"CREATE TABLE IF NOT EXISTS sync_seen (id TEXT PRIMARY KEY); DELETE FROM sync_seen;",
		);
	}

	while (true) {
		const data = (await http.get("/v1/workouts", { page, pageSize })) as {
			workouts?: WorkoutJson[];
			page_count?: number;
		};
		const workouts = data?.workouts ?? [];
		if (workouts.length === 0) break;
		for (const workout of workouts) {
			upsertWorkout(db, workout, options.timezone);
			if (options.reconcileDeletes && workout.id) {
				db.run("INSERT OR IGNORE INTO sync_seen(id) VALUES (?)", [workout.id]);
			}
			imported++;
		}
		db.run("UPDATE sync_state SET last_backfill_page = ? WHERE id = 1", [
			page,
		]);
		options.onProgress?.(imported, total);
		const pageCount = data?.page_count;
		if (typeof pageCount === "number" && page >= pageCount) break;
		page++;
	}

	let removed = 0;
	if (options.reconcileDeletes) {
		const stale = db.all<{ id: string }>(
			"SELECT id FROM workout WHERE id NOT IN (SELECT id FROM sync_seen)",
		);
		for (const row of stale) {
			deleteWorkout(db, row.id);
			removed++;
		}
		db.exec("DROP TABLE IF EXISTS sync_seen");
	}

	db.run(
		`UPDATE sync_state SET backfill_complete = 1,
			last_event_sync_at = ?, workout_count_at_backfill = ? WHERE id = 1`,
		[syncAnchor, total ?? imported],
	);
	return { workouts: imported, pages: page, removed };
}

/** Apply the event feed since the last sync. */
export async function incremental(
	db: SqlDriver,
	http: ReadOnlyHttp,
	options: SyncOptions,
): Promise<{ updated: number; deleted: number }> {
	const state = db.all<{ last_event_sync_at: string | null }>(
		"SELECT last_event_sync_at FROM sync_state WHERE id = 1",
	)[0];
	const since = state?.last_event_sync_at ?? "1970-01-01T00:00:00Z";
	const syncStartedAt = new Date().toISOString();

	let page = 1;
	let updated = 0;
	let deleted = 0;
	while (true) {
		const data = (await http.get("/v1/workouts/events", {
			page,
			pageSize: options.pageSize ?? 10,
			since,
		})) as {
			events?: Array<{
				type?: string;
				workout?: WorkoutJson;
				id?: string;
				deleted_at?: string;
			}>;
			page_count?: number;
		};
		const events = data?.events ?? [];
		if (events.length === 0) break;
		for (const event of events) {
			if (event.type === "deleted" && event.id) {
				deleteWorkout(db, event.id);
				deleted++;
			} else if (event.workout) {
				upsertWorkout(db, event.workout, options.timezone);
				updated++;
			}
		}
		const pageCount = data?.page_count;
		if (typeof pageCount === "number" && page >= pageCount) break;
		page++;
	}

	db.run("UPDATE sync_state SET last_event_sync_at = ? WHERE id = 1", [
		syncStartedAt,
	]);
	return { updated, deleted };
}

/** Refresh the full exercise-template catalog (paged at 100). */
export async function syncTemplates(
	db: SqlDriver,
	http: ReadOnlyHttp,
): Promise<number> {
	let page = 1;
	let count = 0;
	while (true) {
		const data = (await http.get("/v1/exercise_templates", {
			page,
			pageSize: 100,
		})) as {
			exercise_templates?: Array<{
				id?: string;
				title?: string;
				type?: string;
				equipment_category?: string;
				primary_muscle_group?: string;
				secondary_muscle_groups?: string[];
				is_custom?: boolean;
			}>;
			page_count?: number;
		};
		const templates = data?.exercise_templates ?? [];
		if (templates.length === 0) break;
		db.transaction(() => {
			for (const t of templates) {
				if (!t.id) continue;
				db.run(
					`INSERT INTO exercise_template
						(id, title, exercise_type, equipment_category,
						 primary_muscle_group, is_custom, raw_json)
					 VALUES (?,?,?,?,?,?,?)
					 ON CONFLICT(id) DO UPDATE SET
						title=excluded.title, exercise_type=excluded.exercise_type,
						equipment_category=excluded.equipment_category,
						primary_muscle_group=excluded.primary_muscle_group,
						is_custom=excluded.is_custom, raw_json=excluded.raw_json`,
					[
						t.id,
						t.title ?? "",
						t.type ?? null,
						t.equipment_category ?? null,
						t.primary_muscle_group ?? null,
						t.is_custom ? 1 : 0,
						JSON.stringify(t),
					],
				);
				db.run(
					"DELETE FROM template_secondary_muscle WHERE template_id = ?",
					[t.id],
				);
				for (const muscle of t.secondary_muscle_groups ?? []) {
					db.run(
						"INSERT OR IGNORE INTO template_secondary_muscle(template_id, muscle_group) VALUES (?,?)",
						[t.id, muscle],
					);
				}
				count++;
			}
		});
		const pageCount = data?.page_count;
		if (typeof pageCount === "number" && page >= pageCount) break;
		page++;
	}
	return count;
}

/** Refresh body measurements (paged). */
export async function syncBodyMeasurements(
	db: SqlDriver,
	http: ReadOnlyHttp,
): Promise<number> {
	let page = 1;
	let count = 0;
	while (true) {
		const data = (await http.get("/v1/body_measurements", {
			page,
			pageSize: 10,
		})) as {
			body_measurements?: Array<{
				date?: string;
				weight_kg?: number | null;
				fat_percent?: number | null;
				lean_mass_kg?: number | null;
			}>;
			page_count?: number;
		};
		const measurements = data?.body_measurements ?? [];
		if (measurements.length === 0) break;
		db.transaction(() => {
			for (const m of measurements) {
				if (!m.date) continue;
				db.run(
					`INSERT INTO body_measurement
						(date, weight_kg, fat_percent, lean_mass_kg, raw_json)
					 VALUES (?,?,?,?,?)
					 ON CONFLICT(date) DO UPDATE SET
						weight_kg=excluded.weight_kg, fat_percent=excluded.fat_percent,
						lean_mass_kg=excluded.lean_mass_kg, raw_json=excluded.raw_json`,
					[
						m.date,
						m.weight_kg ?? null,
						m.fat_percent ?? null,
						m.lean_mass_kg ?? null,
						JSON.stringify(m),
					],
				);
				count++;
			}
		});
		const pageCount = data?.page_count;
		if (typeof pageCount === "number" && page >= pageCount) break;
		page++;
	}
	return count;
}
