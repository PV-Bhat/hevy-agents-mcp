import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlValue } from "./driver.js";

export interface NodeDriverOptions {
	/**
	 * Open the connection read-only. SQLite then refuses every write at the
	 * engine level, which is the actual guarantee behind the query tool —
	 * no amount of creative SQL can mutate a read-only connection.
	 */
	readOnly?: boolean;
}

/** node:sqlite driver — zero native dependencies, Node >= 22.5. */
export function createNodeDriver(
	path: string,
	options: NodeDriverOptions = {},
): SqlDriver {
	const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
	if (!options.readOnly) {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA foreign_keys = ON;");
	}

	return {
		exec(sql) {
			db.exec(sql);
		},
		run(sql, params = []) {
			db.prepare(sql).run(...(params as SqlValue[]));
		},
		all<T>(sql: string, params: readonly SqlValue[] = []) {
			return db.prepare(sql).all(...(params as SqlValue[])) as T[];
		},
		transaction(fn) {
			db.exec("BEGIN");
			try {
				fn();
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close() {
			db.close();
		},
	};
}
