/**
 * Portable surface: everything that runs on any host.
 *
 * This entry point must never import node:sqlite, node:fs, or any other
 * Node built-in. Cloudflare Workers and Durable Objects import from here,
 * as does @hevy-mcp/core, which has to stay runtime-agnostic. The
 * node-only driver lives behind the package root instead.
 */
export type { SqlDriver, SqlValue } from "./driver.js";
export {
	createReadOnlyHttp,
	createGuardedFetch,
	WriteAttemptError,
	HevyHttpStatusError,
	type ReadOnlyHttp,
	type ReadOnlyHttpOptions,
} from "./read-only-http.js";
export {
	initSchema,
	SCHEMA_DDL,
	VIEWS_DDL,
	SCHEMA_VERSION,
} from "./schema.js";
export { SEMANTIC_VIEWS_DDL, BODYWEIGHT_FRACTIONS } from "./views.js";
export {
	backfill,
	incremental,
	syncTemplates,
	syncBodyMeasurements,
	upsertWorkout,
	deleteWorkout,
	localDateOf,
	recomputeLocalDates,
	runSync,
	type SyncOptions,
	type RunSyncOptions,
	type RunSyncResult,
} from "./sync.js";
export {
	runQuery,
	validateQuery,
	stripLiteralsAndComments,
	QueryRejectedError,
	DEFAULT_MAX_ROWS,
	MAX_MAX_ROWS,
	DEFAULT_MAX_BYTES,
	type QueryFormat,
	type QueryOptions,
	type QueryResult,
} from "./query.js";
export {
	describeSchema,
	renderSchemaText,
	type SchemaDescription,
	type RelationDoc,
} from "./describe.js";
