/**
 * Semantic views — the honest surface an agent queries.
 *
 * Every modeling decision lives here in readable SQL rather than hidden in
 * tool code, so both the agent and the user can see exactly what a number
 * means. Views are dropped and recreated on open, so changing a definition
 * needs no migration.
 *
 * Decisions encoded (agreed with the user):
 *  - Warmup sets are excluded from all volume, PR and e1RM math.
 *  - Volume = weight x reps, and is NULL for exercise types where that
 *    product is meaningless (duration, distance, reps-only). Silently
 *    returning 0 would make cardio look like failed lifting.
 *  - Bodyweight movements get an effective load: bodyweight carried at the
 *    time of the session, plus any added weight, minus assistance.
 *  - Estimated 1RM uses Epley, restricted to 1-12 reps where it is valid.
 *  - Muscle credit: primary 1.0, secondary 0.5. `is_primary` is exposed on
 *    every row so any other weighting can be reproduced in a query.
 */

/**
 * NOTE ON EXERCISE TYPE NAMES
 *
 * The published Hevy OpenAPI spec lists `bodyweight_reps` and
 * `bodyweight_assisted_reps`. The live API actually returns
 * `bodyweight_weighted` and `bodyweight_assisted`, plus `steps_duration`
 * and `floors_duration` which the spec omits entirely. The names below are
 * taken from real responses, not the spec. Verified against 16,955 sets.
 */

/**
 * Share of bodyweight actually moved by each bodyweight movement.
 *
 * Hevy stores no such field, and the correct value is exercise-specific: a
 * pull-up moves ~all of you, a push-up roughly two thirds, a decline crunch
 * only the torso. Without this, bodyweight work either scores zero volume
 * (invisible) or full bodyweight (a 25-rep crunch outscores a heavy squat).
 *
 * Matched longest-prefix-first against the exercise title, so
 * "Pull Up (Weighted)" and "Pull Up (Assisted)" both resolve via "Pull Up".
 * Editable: this is a modeling assumption, not a fact.
 */
export const BODYWEIGHT_FRACTIONS: Record<string, number> = {
	"Pull Up": 1.0,
	"Chin Up": 1.0,
	"Triceps Dip": 1.0,
	Dip: 1.0,
	"Muscle Up": 1.0,
	"Push Up": 0.64,
	"Hanging Leg Raise": 0.5,
	"Leg Raise Parallel Bars": 0.5,
	"Back Extension": 0.45,
	"Glute Ham Raise": 0.45,
	"Decline Crunch": 0.3,
	Crunch: 0.3,
	"Sit Up": 0.3,
	"Standing Calf Raise": 1.0,
};

export const SEMANTIC_VIEWS_DDL = `
-- Bodyweight in effect for each workout: the most recent measurement on or
-- before that session. NULL before the first measurement was ever recorded.
DROP VIEW IF EXISTS v_workout_bodyweight;
CREATE VIEW v_workout_bodyweight AS
SELECT
	w.id AS workout_id,
	(
		SELECT bm.weight_kg FROM body_measurement bm
		WHERE bm.date <= w.local_date AND bm.weight_kg IS NOT NULL
		ORDER BY bm.date DESC LIMIT 1
	) AS bodyweight_kg
FROM workout w;

-- One row per working set, with load and volume resolved per exercise type.
DROP VIEW IF EXISTS v_set;
CREATE VIEW v_set AS
SELECT
	ws.workout_id,
	w.local_date,
	w.start_time,
	w.title AS workout_title,
	ws.exercise_index,
	ws.set_index,
	ws.set_type,
	we.template_id,
	COALESCE(t.title, we.title) AS exercise_title,
	t.exercise_type,
	t.equipment_category,
	t.primary_muscle_group,
	ws.reps,
	ws.weight_kg,
	ws.distance_meters,
	ws.duration_seconds,
	ws.rpe,
	bw.bodyweight_kg,
	bf.fraction AS bodyweight_fraction,
	-- Effective load: what the body actually moved, per exercise type.
	CASE t.exercise_type
		WHEN 'weight_reps' THEN ws.weight_kg
		WHEN 'short_distance_weight' THEN ws.weight_kg
		WHEN 'bodyweight_weighted'
			THEN bw.bodyweight_kg * COALESCE(bf.fraction, 1.0) + COALESCE(ws.weight_kg, 0)
		WHEN 'bodyweight_assisted'
			THEN bw.bodyweight_kg * COALESCE(bf.fraction, 1.0) - COALESCE(ws.weight_kg, 0)
		WHEN 'reps_only'
			THEN bw.bodyweight_kg * bf.fraction
		ELSE NULL
	END AS effective_load_kg,
	-- How volume_kg below was derived. Always check this before comparing
	-- volume across exercise types.
	CASE
		WHEN t.exercise_type IN ('weight_reps','short_distance_weight')
			THEN 'weight_x_reps'
		WHEN t.exercise_type IN ('bodyweight_weighted','bodyweight_assisted')
			THEN 'bodyweight_fraction_plus_added'
		WHEN t.exercise_type = 'reps_only' AND bf.fraction IS NOT NULL
			THEN 'bodyweight_fraction'
		WHEN t.exercise_type = 'reps_only'
			THEN 'unknown_load'
		ELSE 'not_applicable'
	END AS volume_basis,
	-- Tonnage, NULL where the concept does not apply.
	CASE
		WHEN t.exercise_type IN ('weight_reps','short_distance_weight')
			AND ws.weight_kg IS NOT NULL AND ws.reps IS NOT NULL
			THEN ws.weight_kg * ws.reps
		WHEN t.exercise_type = 'bodyweight_weighted'
			AND ws.reps IS NOT NULL AND bw.bodyweight_kg IS NOT NULL
			THEN (bw.bodyweight_kg * COALESCE(bf.fraction, 1.0)
			      + COALESCE(ws.weight_kg, 0)) * ws.reps
		WHEN t.exercise_type = 'bodyweight_assisted'
			AND ws.reps IS NOT NULL AND bw.bodyweight_kg IS NOT NULL
			THEN (bw.bodyweight_kg * COALESCE(bf.fraction, 1.0)
			      - COALESCE(ws.weight_kg, 0)) * ws.reps
		WHEN t.exercise_type = 'reps_only'
			AND ws.reps IS NOT NULL AND bw.bodyweight_kg IS NOT NULL
			AND bf.fraction IS NOT NULL
			THEN bw.bodyweight_kg * bf.fraction * ws.reps
		ELSE NULL
	END AS volume_kg,
	-- Epley estimated 1RM over the load actually moved, so a weighted pull-up
	-- is not estimated from its 5 kg belt plate alone. Restricted to the rep
	-- range where the formula is defensible.
	CASE
		WHEN ws.reps BETWEEN 1 AND 12
			AND CASE t.exercise_type
				WHEN 'weight_reps' THEN ws.weight_kg
				WHEN 'short_distance_weight' THEN ws.weight_kg
				WHEN 'bodyweight_weighted'
					THEN bw.bodyweight_kg * COALESCE(bf.fraction, 1.0) + COALESCE(ws.weight_kg, 0)
				WHEN 'bodyweight_assisted'
					THEN bw.bodyweight_kg * COALESCE(bf.fraction, 1.0) - COALESCE(ws.weight_kg, 0)
				WHEN 'reps_only' THEN bw.bodyweight_kg * bf.fraction
				ELSE NULL
			END > 0
			THEN CASE t.exercise_type
				WHEN 'weight_reps' THEN ws.weight_kg
				WHEN 'short_distance_weight' THEN ws.weight_kg
				WHEN 'bodyweight_weighted'
					THEN bw.bodyweight_kg * COALESCE(bf.fraction, 1.0) + COALESCE(ws.weight_kg, 0)
				WHEN 'bodyweight_assisted'
					THEN bw.bodyweight_kg * COALESCE(bf.fraction, 1.0) - COALESCE(ws.weight_kg, 0)
				WHEN 'reps_only' THEN bw.bodyweight_kg * bf.fraction
				ELSE NULL
			END * (1.0 + ws.reps / 30.0)
		ELSE NULL
	END AS e1rm_kg,
	-- Whether e1rm_kg came from a measured external load or a modelled one.
	CASE
		WHEN t.exercise_type IN ('weight_reps','short_distance_weight')
			THEN 'measured'
		WHEN t.exercise_type IN
			('bodyweight_weighted','bodyweight_assisted','reps_only')
			THEN 'modelled_bodyweight'
		ELSE NULL
	END AS e1rm_basis
FROM workout_set ws
JOIN workout_exercise we
	ON we.workout_id = ws.workout_id AND we.exercise_index = ws.exercise_index
JOIN workout w ON w.id = ws.workout_id
LEFT JOIN exercise_template t ON t.id = we.template_id
LEFT JOIN v_workout_bodyweight bw ON bw.workout_id = ws.workout_id
LEFT JOIN bodyweight_fraction bf
	ON bf.pattern = (
		-- Longest matching title prefix wins, so "Pull Up (Weighted)"
		-- resolves via "Pull Up" and not a shorter accidental match.
		SELECT inner_bf.pattern FROM bodyweight_fraction inner_bf
		WHERE COALESCE(t.title, we.title) LIKE inner_bf.pattern || '%'
		ORDER BY LENGTH(inner_bf.pattern) DESC LIMIT 1
	)
WHERE ws.set_type IS NULL OR ws.set_type <> 'warmup';

-- One row per (set, muscle). A set on a compound lift appears several times,
-- once per muscle involved, with the credit share attached. SUM volume_kg
-- across this view double counts by design: filter or weight by credit.
DROP VIEW IF EXISTS v_set_muscle;
CREATE VIEW v_set_muscle AS
SELECT s.*, s.primary_muscle_group AS muscle_group, 1 AS is_primary,
	1.0 AS credit,
	s.volume_kg AS credited_volume_kg
FROM v_set s
WHERE s.primary_muscle_group IS NOT NULL
UNION ALL
SELECT s.*, sm.muscle_group, 0 AS is_primary,
	0.5 AS credit,
	s.volume_kg * 0.5 AS credited_volume_kg
FROM v_set s
JOIN template_secondary_muscle sm ON sm.template_id = s.template_id;

-- One row per session.
DROP VIEW IF EXISTS v_session;
CREATE VIEW v_session AS
SELECT
	w.id AS workout_id,
	w.local_date,
	w.start_time,
	w.title,
	w.duration_seconds,
	COUNT(DISTINCT s.exercise_index) AS exercise_count,
	COUNT(*) AS working_set_count,
	SUM(s.volume_kg) AS volume_kg,
	SUM(s.reps) AS total_reps,
	AVG(s.rpe) AS avg_rpe
FROM workout w
LEFT JOIN v_set s ON s.workout_id = w.id
GROUP BY w.id;

-- Weekly volume per muscle group, secondary muscles credited at 0.5.
-- %G-%V is the true ISO week-year and week number. %Y-%W would put
-- 2026-01-01 in "2026-00" and split the turn-of-year week across two labels.
DROP VIEW IF EXISTS v_weekly_muscle_volume;
CREATE VIEW v_weekly_muscle_volume AS
SELECT
	strftime('%G-W%V', local_date) AS iso_week,
	MIN(local_date) AS week_start,
	muscle_group,
	SUM(credited_volume_kg) AS volume_kg,
	SUM(credit) AS credited_sets,
	COUNT(DISTINCT workout_id) AS sessions
FROM v_set_muscle
GROUP BY iso_week, muscle_group;

-- Best single set per exercise per day, by estimated 1RM.
DROP VIEW IF EXISTS v_daily_exercise_best;
CREATE VIEW v_daily_exercise_best AS
SELECT
	local_date,
	template_id,
	exercise_title,
	MAX(e1rm_kg) AS best_e1rm_kg,
	MAX(weight_kg) AS heaviest_weight_kg,
	SUM(volume_kg) AS volume_kg,
	COUNT(*) AS sets
FROM v_set
GROUP BY local_date, template_id;

-- Rep-max personal records: heaviest weight ever lifted at each rep count.
DROP VIEW IF EXISTS v_rep_max_pr;
CREATE VIEW v_rep_max_pr AS
SELECT template_id, exercise_title, reps,
	MAX(weight_kg) AS best_weight_kg
FROM v_set
WHERE reps IS NOT NULL AND weight_kg > 0
GROUP BY template_id, reps;
`;
