/**
 * Self-documenting schema description.
 *
 * This is the highest-leverage surface in the project: an agent that reads
 * this can answer questions nobody anticipated, without a bespoke tool per
 * question. It states the modeling decisions explicitly, because a number
 * whose definition is unknown is worse than no number.
 */
import type { SqlDriver } from "./driver.js";

export interface ColumnDoc {
	name: string;
	type: string;
	note?: string;
}

export interface RelationDoc {
	name: string;
	kind: "table" | "view";
	purpose: string;
	columns: ColumnDoc[];
}

export interface SchemaDescription {
	dataset: {
		workouts: number;
		sets: number;
		exercises: number;
		firstDate: string | null;
		lastDate: string | null;
		timezone: string | null;
	};
	conventions: string[];
	relations: RelationDoc[];
	examples: { question: string; sql: string }[];
	caveats: string[];
	/**
	 * The live modeling assumptions, read from the database rather than from
	 * source constants. Anyone reading a number this server produced can see
	 * the exact values that produced it, and how to change them.
	 */
	assumptions: {
		secondaryMuscleCredit: number;
		e1rmFormula: string;
		e1rmValidRepRange: string;
		bodyweightFractions: { pattern: string; fraction: number }[];
		howToChange: string[];
	};
}

const CONVENTIONS = [
	"All weights are kilograms, distances metres, durations seconds.",
	"Use local_date (YYYY-MM-DD, user's timezone) for any day/week/month grouping. start_time is a UTC instant and will misassign late-evening sessions.",
	"Warmup sets are already excluded from every view whose name starts with v_. Query workout_set directly if you specifically need them.",
	"volume_kg is NULL, not 0, where weight x reps is meaningless (cardio, duration and reps-only movements). Filter with WHERE volume_kg IS NOT NULL.",
	"e1rm_kg uses the Epley formula over effective_load_kg, not the logged weight, so a weighted pull-up is not estimated from its belt plate alone. Only populated for 1-12 rep sets. e1rm_basis says whether the load was measured or modelled from bodyweight.",
	"Always read volume_basis alongside volume_kg. 'weight_x_reps' is measured; 'bodyweight_fraction' and 'bodyweight_fraction_plus_added' are modelled from the user's bodyweight and an editable per-exercise fraction (see the bodyweight_fraction table); 'unknown_load' and 'not_applicable' mean volume_kg is NULL. Do not compare modelled and measured volume without saying so.",
	"iso_week in v_weekly_muscle_volume is a true ISO week-year label (%G-W%V), so the week spanning new year stays in one bucket.",
	"In v_set_muscle each set appears once per muscle involved. Primary muscle gets credit 1.0, secondary muscles 0.5. Summing volume_kg there double counts; sum credited_volume_kg instead, or filter on is_primary = 1.",
];

const CAVEATS = [
	"Personal records come in three distinct flavours and they disagree: heaviest ever single (MAX(weight_kg)), rep-max at a given rep count (v_rep_max_pr), and best estimated 1RM (MAX(e1rm_kg)). Say which one you mean.",
	"Exercise substitutions are separate template_ids: 'Bench Press (Barbell)' and 'Bench Press (Dumbbell)' will not aggregate together unless grouped via exercise_group.",
	"Bodyweight-based loads depend on body_measurement history; effective_load_kg is NULL for sessions before the first recorded bodyweight.",
	"A small number of historical exercises reference templates deleted from the Hevy catalog; those rows have a NULL exercise_type and so a NULL volume_kg. exercise_title is still populated.",
	"The live Hevy API returns exercise_type values that differ from its published spec: bodyweight_weighted and bodyweight_assisted (not *_reps), plus steps_duration and floors_duration. Trust the values in exercise_template, not external documentation.",
];

const RELATIONS: RelationDoc[] = [
	{
		name: "v_set",
		kind: "view",
		purpose:
			"The main working surface: one row per non-warmup set with load, volume and estimated 1RM resolved per exercise type. Start here.",
		columns: [
			{ name: "workout_id", type: "TEXT" },
			{ name: "local_date", type: "TEXT", note: "YYYY-MM-DD, user timezone" },
			{ name: "start_time", type: "TEXT", note: "UTC instant" },
			{ name: "workout_title", type: "TEXT" },
			{ name: "exercise_title", type: "TEXT" },
			{ name: "template_id", type: "TEXT" },
			{ name: "exercise_type", type: "TEXT", note: "weight_reps, duration, ..." },
			{ name: "equipment_category", type: "TEXT" },
			{ name: "primary_muscle_group", type: "TEXT" },
			{ name: "reps", type: "INTEGER" },
			{ name: "weight_kg", type: "REAL", note: "as logged; added weight for bodyweight moves" },
			{ name: "effective_load_kg", type: "REAL", note: "what the body moved, incl. bodyweight" },
			{ name: "volume_kg", type: "REAL", note: "NULL where meaningless" },
			{ name: "volume_basis", type: "TEXT", note: "how volume_kg was derived; read this" },
			{ name: "e1rm_kg", type: "REAL", note: "Epley over effective load, 1-12 reps only" },
			{ name: "e1rm_basis", type: "TEXT", note: "measured | modelled_bodyweight" },
			{ name: "rpe", type: "REAL" },
			{ name: "bodyweight_kg", type: "REAL", note: "carried at time of session" },
			{ name: "bodyweight_fraction", type: "REAL", note: "share of bodyweight the movement loads" },
			{ name: "duration_seconds", type: "REAL" },
			{ name: "distance_meters", type: "REAL" },
			{ name: "set_type", type: "TEXT", note: "normal, failure, dropset" },
		],
	},
	{
		name: "v_session",
		kind: "view",
		purpose: "One row per workout with totals. Use for frequency and per-session trends.",
		columns: [
			{ name: "workout_id", type: "TEXT" },
			{ name: "local_date", type: "TEXT" },
			{ name: "title", type: "TEXT" },
			{ name: "duration_seconds", type: "INTEGER" },
			{ name: "exercise_count", type: "INTEGER" },
			{ name: "working_set_count", type: "INTEGER" },
			{ name: "volume_kg", type: "REAL" },
			{ name: "total_reps", type: "INTEGER" },
			{ name: "avg_rpe", type: "REAL" },
		],
	},
	{
		name: "v_set_muscle",
		kind: "view",
		purpose:
			"v_set exploded per muscle involved, with credit share. Use for per-muscle volume.",
		columns: [
			{ name: "muscle_group", type: "TEXT" },
			{ name: "is_primary", type: "INTEGER", note: "1 primary, 0 secondary" },
			{ name: "credit", type: "REAL", note: "1.0 primary, 0.5 secondary" },
			{ name: "credited_volume_kg", type: "REAL", note: "volume_kg * credit" },
			{ name: "...", type: "", note: "plus every column of v_set" },
		],
	},
	{
		name: "v_weekly_muscle_volume",
		kind: "view",
		purpose: "Pre-aggregated weekly volume and set count per muscle group.",
		columns: [
			{ name: "iso_week", type: "TEXT", note: "YYYY-WW" },
			{ name: "week_start", type: "TEXT" },
			{ name: "muscle_group", type: "TEXT" },
			{ name: "volume_kg", type: "REAL", note: "credited" },
			{ name: "credited_sets", type: "REAL" },
			{ name: "sessions", type: "INTEGER" },
		],
	},
	{
		name: "v_daily_exercise_best",
		kind: "view",
		purpose: "Best set per exercise per day. Use for progression curves.",
		columns: [
			{ name: "local_date", type: "TEXT" },
			{ name: "template_id", type: "TEXT" },
			{ name: "exercise_title", type: "TEXT" },
			{ name: "best_e1rm_kg", type: "REAL" },
			{ name: "heaviest_weight_kg", type: "REAL" },
			{ name: "volume_kg", type: "REAL" },
			{ name: "sets", type: "INTEGER" },
		],
	},
	{
		name: "v_rep_max_pr",
		kind: "view",
		purpose: "Heaviest weight ever lifted at each rep count, per exercise.",
		columns: [
			{ name: "template_id", type: "TEXT" },
			{ name: "exercise_title", type: "TEXT" },
			{ name: "reps", type: "INTEGER" },
			{ name: "best_weight_kg", type: "REAL" },
		],
	},
	{
		name: "workout",
		kind: "table",
		purpose: "Raw workout rows. raw_json holds the untouched API payload.",
		columns: [
			{ name: "id", type: "TEXT" },
			{ name: "title", type: "TEXT" },
			{ name: "start_time", type: "TEXT" },
			{ name: "end_time", type: "TEXT" },
			{ name: "local_date", type: "TEXT" },
			{ name: "duration_seconds", type: "INTEGER" },
			{ name: "raw_json", type: "TEXT", note: "large; do not SELECT * casually" },
		],
	},
	{
		name: "workout_set",
		kind: "table",
		purpose:
			"Raw sets including warmups. Prefer v_set unless you specifically need warmups.",
		columns: [
			{ name: "workout_id", type: "TEXT" },
			{ name: "exercise_index", type: "INTEGER" },
			{ name: "set_index", type: "INTEGER" },
			{ name: "set_type", type: "TEXT", note: "warmup, normal, failure, dropset" },
			{ name: "weight_kg", type: "REAL" },
			{ name: "reps", type: "INTEGER" },
			{ name: "rpe", type: "REAL" },
		],
	},
	{
		name: "exercise_template",
		kind: "table",
		purpose: "Catalog of movements with muscle and equipment metadata.",
		columns: [
			{ name: "id", type: "TEXT" },
			{ name: "title", type: "TEXT" },
			{ name: "exercise_type", type: "TEXT" },
			{ name: "equipment_category", type: "TEXT" },
			{ name: "primary_muscle_group", type: "TEXT" },
			{ name: "is_custom", type: "INTEGER" },
		],
	},
	{
		name: "body_measurement",
		kind: "table",
		purpose: "Bodyweight and composition over time, keyed by date.",
		columns: [
			{ name: "date", type: "TEXT" },
			{ name: "weight_kg", type: "REAL" },
			{ name: "fat_percent", type: "REAL" },
			{ name: "lean_mass_kg", type: "REAL" },
		],
	},
	{
		name: "exercise_group",
		kind: "table",
		purpose:
			"User-defined equivalence classes so substitutions aggregate. Join exercise_group_member on template_id.",
		columns: [
			{ name: "id", type: "INTEGER" },
			{ name: "name", type: "TEXT" },
		],
	},
];

const EXAMPLES = [
	{
		question: "How much has my bench press estimated 1RM changed each quarter?",
		sql: `SELECT substr(local_date,1,4) AS year,
       (CAST(substr(local_date,6,2) AS INTEGER)+2)/3 AS quarter,
       MAX(best_e1rm_kg) AS best_e1rm_kg
FROM v_daily_exercise_best
WHERE exercise_title LIKE '%Bench Press%'
GROUP BY year, quarter
ORDER BY year, quarter`,
	},
	{
		question: "Weekly volume per muscle group for the last 12 weeks",
		sql: `SELECT week_start, muscle_group, ROUND(volume_kg) AS volume_kg
FROM v_weekly_muscle_volume
WHERE week_start >= date('now','-84 days')
ORDER BY week_start, volume_kg DESC`,
	},
	{
		question: "Which exercises have I plateaued on over the last year?",
		sql: `WITH monthly AS (
  SELECT template_id, exercise_title,
         substr(local_date,1,7) AS month,
         MAX(best_e1rm_kg) AS e1rm
  FROM v_daily_exercise_best
  WHERE local_date >= date('now','-365 days') AND best_e1rm_kg IS NOT NULL
  GROUP BY template_id, month
)
SELECT exercise_title,
       COUNT(*) AS months,
       MIN(e1rm) AS worst, MAX(e1rm) AS best,
       ROUND(100.0*(MAX(e1rm)-MIN(e1rm))/MIN(e1rm),1) AS pct_range
FROM monthly
GROUP BY template_id
HAVING months >= 6
ORDER BY pct_range ASC
LIMIT 20`,
	},
	{
		question: "My training frequency by month, all time",
		sql: `SELECT substr(local_date,1,7) AS month,
       COUNT(*) AS sessions,
       ROUND(AVG(volume_kg)) AS avg_volume_kg,
       ROUND(AVG(duration_seconds)/60.0) AS avg_minutes
FROM v_session
GROUP BY month ORDER BY month`,
	},
	{
		question: "Am I neglecting any muscle group relative to a year ago?",
		sql: `SELECT muscle_group,
       SUM(CASE WHEN local_date >= date('now','-90 days')
                THEN credited_volume_kg END) AS recent_90d,
       SUM(CASE WHEN local_date BETWEEN date('now','-455 days')
                                    AND date('now','-365 days')
                THEN credited_volume_kg END) AS same_window_last_year
FROM v_set_muscle
GROUP BY muscle_group
ORDER BY recent_90d DESC`,
	},
	{
		question: "Heaviest single ever, per exercise",
		sql: `SELECT exercise_title, MAX(weight_kg) AS heaviest_kg,
       MAX(reps) FILTER (WHERE weight_kg = (
         SELECT MAX(weight_kg) FROM v_set inner_s
         WHERE inner_s.template_id = v_set.template_id)) AS reps_at_best
FROM v_set
WHERE weight_kg > 0
GROUP BY template_id
ORDER BY heaviest_kg DESC
LIMIT 25`,
	},
];

export function describeSchema(db: SqlDriver): SchemaDescription {
	const [stats] = db.all<{
		workouts: number;
		sets: number;
		exercises: number;
		firstDate: string | null;
		lastDate: string | null;
	}>(
		`SELECT
			(SELECT COUNT(*) FROM workout) AS workouts,
			(SELECT COUNT(*) FROM workout_set) AS sets,
			(SELECT COUNT(DISTINCT template_id) FROM workout_exercise) AS exercises,
			(SELECT MIN(local_date) FROM workout) AS firstDate,
			(SELECT MAX(local_date) FROM workout) AS lastDate`,
	);
	const [tz] = db.all<{ value: string }>(
		"SELECT value FROM meta WHERE key = 'timezone'",
	);

	const bodyweightFractions = db.all<{
		pattern: string;
		fraction: number;
	}>(
		"SELECT pattern, fraction FROM bodyweight_fraction ORDER BY fraction DESC, pattern",
	);

	return {
		dataset: { ...stats, timezone: tz?.value ?? null },
		conventions: CONVENTIONS,
		relations: RELATIONS,
		examples: EXAMPLES,
		caveats: CAVEATS,
		assumptions: {
			secondaryMuscleCredit: 0.5,
			e1rmFormula: "Epley: weight * (1 + reps / 30)",
			e1rmValidRepRange: "1-12 reps, load above zero",
			bodyweightFractions,
			howToChange: [
				"Bodyweight fractions live in the bodyweight_fraction table and are matched against the longest exercise-title prefix. They affect volume_kg, effective_load_kg and e1rm_kg for bodyweight movements.",
				"Change one with the sync CLI: `hevy-warehouse set-fraction \"Push Up\" 0.7`, or list them with `hevy-warehouse fractions`.",
				"Views recompute on the next server start, so no re-sync from Hevy is needed after a change.",
				"The secondary-muscle credit of 0.5 is fixed in the v_set_muscle view. To use a different weighting in one query, read is_primary and apply your own factor rather than credited_volume_kg.",
			],
		},
	};
}

/** Compact text rendering for models that prefer prose over JSON. */
export function renderSchemaText(description: SchemaDescription): string {
	const lines: string[] = [];
	const d = description.dataset;
	lines.push(
		`Hevy training warehouse: ${d.workouts} workouts, ${d.sets} sets, ` +
			`${d.exercises} distinct exercises, ${d.firstDate} to ${d.lastDate}` +
			(d.timezone ? ` (timezone ${d.timezone})` : ""),
	);
	lines.push("", "CONVENTIONS");
	for (const c of description.conventions) lines.push(`- ${c}`);
	lines.push("", "RELATIONS");
	for (const r of description.relations) {
		lines.push(`${r.kind} ${r.name} — ${r.purpose}`);
		for (const col of r.columns) {
			lines.push(
				`    ${col.name}${col.type ? ` ${col.type}` : ""}${col.note ? `  -- ${col.note}` : ""}`,
			);
		}
	}
	const a = description.assumptions;
	lines.push(
		"",
		"MODELING ASSUMPTIONS (chosen values, not measurements — state them when reporting derived numbers)",
		`- Estimated 1RM: ${a.e1rmFormula}, valid for ${a.e1rmValidRepRange}.`,
		`- Secondary muscles receive ${a.secondaryMuscleCredit} of the volume credit; primary receives 1.0.`,
		"- Bodyweight fractions, the share of bodyweight each movement loads:",
	);
	for (const f of a.bodyweightFractions) {
		lines.push(`    ${f.fraction.toFixed(2)}  ${f.pattern}`);
	}
	lines.push("  Changing these:");
	for (const h of a.howToChange) lines.push(`    - ${h}`);

	lines.push("", "CAVEATS");
	for (const c of description.caveats) lines.push(`- ${c}`);
	lines.push("", "EXAMPLES");
	for (const e of description.examples) {
		lines.push(`-- ${e.question}`, e.sql, "");
	}
	return lines.join("\n");
}
