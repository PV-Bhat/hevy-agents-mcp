/**
 * Read-only query surface.
 *
 * Defence is layered, strongest first:
 *  1. The connection is opened read-only, so SQLite itself refuses every
 *     write regardless of what SQL arrives. This is the real guarantee.
 *  2. Statement validation below rejects non-SELECT input early, so an
 *     agent gets a clear error instead of a driver-level one, and so
 *     PRAGMA/ATTACH cannot be used for probing.
 *  3. Row and byte caps keep a careless `SELECT *` from flooding the
 *     model's context window.
 */
import type { SqlDriver, SqlValue } from "./driver.js";

export class QueryRejectedError extends Error {
	constructor(reason: string) {
		super(`Query rejected: ${reason}`);
		this.name = "QueryRejectedError";
	}
}

export const DEFAULT_MAX_ROWS = 500;
export const MAX_MAX_ROWS = 5_000;
export const DEFAULT_MAX_BYTES = 100_000;

/** Statement prefixes that are allowed. */
const ALLOWED_PREFIX = /^(select|with)\b/i;

/**
 * Tokens that must never appear as a statement keyword. Matched on word
 * boundaries against the comment-stripped, string-literal-stripped SQL so
 * that an exercise titled "Attach Bar Row" cannot trip the filter.
 */
const FORBIDDEN_KEYWORDS = [
	"attach",
	"detach",
	"pragma",
	"insert",
	"update",
	"delete",
	"drop",
	"create",
	"alter",
	"replace",
	"vacuum",
	"reindex",
	"analyze",
	"begin",
	"commit",
	"rollback",
	"savepoint",
	"release",
	"grant",
	"revoke",
];

/** Remove comments and string/identifier literals so keyword scanning is safe. */
export function stripLiteralsAndComments(sql: string): string {
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const two = sql.slice(i, i + 2);
		if (two === "--") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? sql.length : end;
			continue;
		}
		if (two === "/*") {
			const end = sql.indexOf("*/", i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		const char = sql[i];
		if (char === "'" || char === '"' || char === "`" || char === "[") {
			const closer = char === "[" ? "]" : char;
			i++;
			while (i < sql.length) {
				if (sql[i] === closer) {
					// Doubled quote is an escaped literal, not a terminator.
					if (sql[i + 1] === closer) {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			out += " ";
			continue;
		}
		out += char;
		i++;
	}
	return out;
}

export function validateQuery(sql: string): string {
	const trimmed = sql.trim();
	if (!trimmed) throw new QueryRejectedError("empty query");

	const bare = stripLiteralsAndComments(trimmed).trim();

	if (!ALLOWED_PREFIX.test(bare)) {
		throw new QueryRejectedError(
			"only SELECT and WITH statements are allowed. This surface is read-only.",
		);
	}

	// Reject multiple statements. A single trailing semicolon is fine.
	const withoutTrailing = bare.replace(/;\s*$/, "");
	if (withoutTrailing.includes(";")) {
		throw new QueryRejectedError(
			"only one statement per query; remove the extra semicolon",
		);
	}

	for (const keyword of FORBIDDEN_KEYWORDS) {
		if (new RegExp(`\\b${keyword}\\b`, "i").test(withoutTrailing)) {
			throw new QueryRejectedError(
				`the keyword "${keyword}" is not permitted on the read-only query surface`,
			);
		}
	}

	return trimmed;
}

/** Strip a single trailing semicolon so the statement can be wrapped. */
export function stripTrailingSemicolon(sql: string): string {
	return sql.trim().replace(/;\s*$/, "");
}

export type QueryFormat = "json" | "csv" | "markdown";

export interface QueryOptions {
	maxRows?: number;
	maxBytes?: number;
	format?: QueryFormat;
	params?: readonly SqlValue[];
}

export interface QueryResult {
	rows: Record<string, SqlValue>[];
	rowCount: number;
	truncated: boolean;
	columns: string[];
	formatted: string;
	format: QueryFormat;
	notes?: string[];
}

function csvEscape(value: SqlValue): string {
	if (value === null) return "";
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatRows(
	rows: Record<string, SqlValue>[],
	columns: string[],
	format: QueryFormat,
): string {
	if (format === "json") return JSON.stringify(rows);
	if (rows.length === 0) return "";
	if (format === "csv") {
		const header = columns.map((c) => csvEscape(c)).join(",");
		const body = rows.map((row) =>
			columns.map((c) => csvEscape(row[c] ?? null)).join(","),
		);
		return [header, ...body].join("\n");
	}
	// markdown
	const header = `| ${columns.join(" | ")} |`;
	const divider = `| ${columns.map(() => "---").join(" | ")} |`;
	const body = rows.map(
		(row) =>
			`| ${columns.map((c) => (row[c] === null || row[c] === undefined ? "" : String(row[c]))).join(" | ")} |`,
	);
	return [header, divider, ...body].join("\n");
}

/**
 * Execute a validated read-only query. `db` must be a read-only driver;
 * this function does not itself grant write protection.
 */
export function runQuery(
	db: SqlDriver,
	sql: string,
	options: QueryOptions = {},
): QueryResult {
	const validated = validateQuery(sql);
	const maxRows = Math.min(options.maxRows ?? DEFAULT_MAX_ROWS, MAX_MAX_ROWS);
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const format = options.format ?? "json";
	const notes: string[] = [];

	// Push the cap into SQL rather than materializing every row and slicing.
	// An unbounded `SELECT * FROM v_set` would otherwise load the entire
	// history into memory before being discarded. One extra row is requested
	// so truncation is detectable without a second query.
	const limited = `SELECT * FROM (${stripTrailingSemicolon(validated)}) LIMIT ${maxRows + 1}`;
	const all = db.all<Record<string, SqlValue>>(limited, options.params ?? []);
	const rowLimitHit = all.length > maxRows;
	let rows = rowLimitHit ? all.slice(0, maxRows) : all;
	if (rowLimitHit) {
		notes.push(
			`Result truncated to ${maxRows} rows (the query matched more). ` +
				"Add LIMIT, aggregate, or raise maxRows.",
		);
	}

	const columns = rows[0] ? Object.keys(rows[0]) : [];
	let formatted = formatRows(rows, columns, format);

	// Byte cap: shed rows until the payload fits, so a wide result set
	// cannot blow the context window even under the row cap.
	let byteLimitHit = false;
	if (formatted.length > maxBytes && rows.length > 1) {
		let keep = rows.length;
		while (keep > 1 && formatted.length > maxBytes) {
			keep = Math.floor(keep / 2);
			rows = rows.slice(0, keep);
			formatted = formatRows(rows, columns, format);
		}
		byteLimitHit = true;
		notes.push(
			`Result further reduced to ${rows.length} rows to stay under ${maxBytes} bytes.`,
		);
	}

	return {
		rows,
		rowCount: rows.length,
		// Any reduction at all, by row cap or byte cap. Reporting false after
		// shedding rows would let an agent present a partial answer as complete.
		truncated: rowLimitHit || byteLimitHit,
		columns,
		formatted,
		format,
		...(notes.length > 0 ? { notes } : {}),
	};
}
