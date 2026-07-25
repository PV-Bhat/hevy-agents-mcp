declare const __HEVY_MCP_NAME__: string | undefined;
declare const __HEVY_MCP_VERSION__: string | undefined;

export const SERVER_NAME =
	typeof __HEVY_MCP_NAME__ === "string" ? __HEVY_MCP_NAME__ : "hevy-mcp";
export const SERVER_VERSION =
	typeof __HEVY_MCP_VERSION__ === "string" ? __HEVY_MCP_VERSION__ : "dev";

/**
 * Guidance added when a local warehouse is attached. Without this the model
 * still reaches for get-workouts and pages ten at a time, because that is
 * what the base instructions describe. Naming the query tool and saying
 * plainly that it supersedes paging is what actually changes the behaviour.
 */
export const WAREHOUSE_INSTRUCTIONS = [
	"Training history: a complete local copy of this account's workout history is attached, queryable with SQL. For ANY question spanning more than the last few sessions - progression, personal records, volume by muscle group, plateaus, comparisons between periods, anything about a specific year or 'since I started' - use run-training-query. Do not page through get-workouts for analysis; it returns at most 10 workouts per call and cannot aggregate.",
	"Call describe-training-schema before your first query in a conversation. It lists the tables and views, states how volume, estimated one-rep-max and muscle attribution are defined, and includes worked examples. Guessing column names wastes turns.",
	"Some figures are modelled rather than measured: bodyweight movements use the user's recorded bodyweight and a per-exercise fraction, and secondary muscles receive half credit for volume. Read volume_basis alongside volume_kg, and say which is which when a distinction would change the conclusion.",
	"The local copy is refreshed by sync-training-history, which reads from Hevy and never writes to the account. Check get-warehouse-status if currency matters; a sync is not needed before every query.",
].join("\n\n");

export const SERVER_INSTRUCTIONS = [
	"Hevy MCP connects clients to the authenticated user's Hevy workout-tracking data, including workouts, routines, exercise templates, routine folders, body measurements, and profile information. HEVY_API_KEY must contain a valid Hevy API key for local stdio use.",
	"Safety: all get-* and search-* tools are read-only. create-* and update-* tools mutate Hevy data. Creates are additive and non-idempotent, so repeating one can create duplicates. Updates can overwrite existing data. Delete operations are not available.",
	"Workflow: search exercise templates first, then use the returned template IDs when creating workouts or routines. To create a completed workout from a routine, fetch the routine as a plan, then obtain the actual completed sets and end time from the user; never invent completion data.",
	"Pagination: start at page 1 and fetch only the pages needed. Most list tools allow pageSize up to 10; get-exercise-templates allows up to 100.",
	"Rate limits and retries: minimize repeated calls. If Hevy returns HTTP 429, follow its retry guidance. Transient read requests retry automatically, but write requests do not; confirm uncertain write outcomes before trying again.",
].join("\n\n");

/** Instructions for a server that does or does not have a warehouse attached. */
export function serverInstructions(hasWarehouse: boolean): string {
	return hasWarehouse
		? [SERVER_INSTRUCTIONS, WAREHOUSE_INSTRUCTIONS].join("\n\n")
		: SERVER_INSTRUCTIONS;
}
