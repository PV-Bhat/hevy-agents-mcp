/**
 * Warehouse schema.
 *
 * Design rules:
 *  - Raw API JSON is preserved per workout (`raw_json`) so every derived
 *    row can be rebuilt after a schema or semantics change without
 *    re-downloading from Hevy.
 *  - Times are stored twice: the UTC instant from the API, and the local
 *    date derived with the configured timezone. Weekly/daily bucketing
 *    must use local_date, never the UTC instant.
 *  - Semantic decisions (warmup handling, muscle attribution weights,
 *    e1RM formula) live in SQL views, not in tool code, so agents and
 *    humans can read exactly what the numbers mean.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	backfill_complete INTEGER NOT NULL DEFAULT 0,
	last_event_sync_at TEXT,        -- ISO timestamp handed to /v1/workouts/events?since=
	last_backfill_page INTEGER,     -- resume point if a backfill is interrupted
	workout_count_at_backfill INTEGER
);

CREATE TABLE IF NOT EXISTS exercise_template (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	exercise_type TEXT,             -- weight_reps | bodyweight_reps | duration | ...
	equipment_category TEXT,
	primary_muscle_group TEXT,
	is_custom INTEGER NOT NULL DEFAULT 0,
	raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_secondary_muscle (
	template_id TEXT NOT NULL REFERENCES exercise_template(id),
	muscle_group TEXT NOT NULL,
	PRIMARY KEY (template_id, muscle_group)
);

CREATE TABLE IF NOT EXISTS workout (
	id TEXT PRIMARY KEY,
	title TEXT,
	description TEXT,
	start_time TEXT,                -- UTC instant as returned by the API
	end_time TEXT,
	local_date TEXT,                -- YYYY-MM-DD in the configured timezone
	duration_seconds INTEGER,
	updated_at TEXT,
	created_at TEXT,
	raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workout_local_date ON workout(local_date);
CREATE INDEX IF NOT EXISTS idx_workout_start_time ON workout(start_time);

CREATE TABLE IF NOT EXISTS workout_exercise (
	workout_id TEXT NOT NULL REFERENCES workout(id) ON DELETE CASCADE,
	exercise_index INTEGER NOT NULL,
	template_id TEXT,               -- not FK-enforced: history may reference deleted templates
	title TEXT,
	notes TEXT,
	superset_id INTEGER,
	PRIMARY KEY (workout_id, exercise_index)
);
CREATE INDEX IF NOT EXISTS idx_we_template ON workout_exercise(template_id);

CREATE TABLE IF NOT EXISTS workout_set (
	workout_id TEXT NOT NULL,
	exercise_index INTEGER NOT NULL,
	set_index INTEGER NOT NULL,
	set_type TEXT,                  -- warmup | normal | failure | dropset
	weight_kg REAL,
	reps INTEGER,
	distance_meters REAL,
	duration_seconds REAL,
	rpe REAL,
	custom_metric REAL,
	PRIMARY KEY (workout_id, exercise_index, set_index),
	FOREIGN KEY (workout_id, exercise_index)
		REFERENCES workout_exercise(workout_id, exercise_index) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS body_measurement (
	date TEXT PRIMARY KEY,          -- YYYY-MM-DD
	weight_kg REAL,
	fat_percent REAL,
	lean_mass_kg REAL,
	raw_json TEXT NOT NULL
);

-- User-defined equivalence classes: "Bench Press (Barbell)" and
-- "Bench Press (Dumbbell)" can be grouped so progression analysis
-- survives gym changes. Populated by the user/agent, not by sync.
CREATE TABLE IF NOT EXISTS exercise_group (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS exercise_group_member (
	group_id INTEGER NOT NULL REFERENCES exercise_group(id) ON DELETE CASCADE,
	template_id TEXT NOT NULL,
	PRIMARY KEY (group_id, template_id)
);
`;

/**
 * Semantic views, versioned separately from tables. These are dropped and
 * recreated on every open so definition changes apply without migration.
 *
 * Current defaults (each is a decision the user signed off on, or a
 * placeholder awaiting one):
 *  - v_working_set: warmup sets excluded from all volume/PR math.
 */
export const VIEWS_DDL = `
DROP VIEW IF EXISTS v_working_set;
CREATE VIEW v_working_set AS
SELECT
	s.workout_id,
	w.local_date,
	w.start_time,
	s.exercise_index,
	we.template_id,
	we.title AS exercise_title,
	t.exercise_type,
	t.primary_muscle_group,
	s.set_index,
	s.set_type,
	s.weight_kg,
	s.reps,
	s.distance_meters,
	s.duration_seconds,
	s.rpe
FROM workout_set s
JOIN workout_exercise we
	ON we.workout_id = s.workout_id AND we.exercise_index = s.exercise_index
JOIN workout w ON w.id = s.workout_id
LEFT JOIN exercise_template t ON t.id = we.template_id
WHERE s.set_type IS NULL OR s.set_type <> 'warmup';
`;

import type { SqlDriver } from "./driver.js";

export function initSchema(db: SqlDriver): void {
	db.exec(SCHEMA_DDL);
	db.exec(VIEWS_DDL);
	db.run(
		"INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[String(SCHEMA_VERSION)],
	);
	db.run(
		"INSERT INTO sync_state(id, backfill_complete) VALUES(1, 0) " +
			"ON CONFLICT(id) DO NOTHING",
	);
}
