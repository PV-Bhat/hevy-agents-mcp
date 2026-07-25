/**
 * Storage seam. Everything above this interface (schema, sync, analytics,
 * MCP tools) is host-agnostic; everything below it is one of two drivers:
 *
 *  - node:sqlite  (local / VPS)
 *  - Durable Object SQLite  (Cloudflare hosted path, later)
 *
 * Keep this interface minimal — every method added here must be
 * implementable on both.
 */

export interface SqlDriver {
	/** Run DDL or multiple statements; no results. */
	exec(sql: string): void;
	/** Run one statement with bound params; no results. */
	run(sql: string, params?: readonly SqlValue[]): void;
	/** Query rows. */
	all<T = Record<string, SqlValue>>(
		sql: string,
		params?: readonly SqlValue[],
	): T[];
	/** Execute fn atomically (BEGIN/COMMIT, ROLLBACK on throw). */
	transaction(fn: () => void): void;
	close(): void;
}

export type SqlValue = string | number | bigint | null | Uint8Array;
