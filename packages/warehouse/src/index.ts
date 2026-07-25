/**
 * Package root: the portable surface plus the Node-only SQLite driver.
 * Runtimes without node:sqlite (Workers, Durable Objects) must import
 * "@hevy-mcp/warehouse/portable" instead.
 */
export * from "./portable.js";
export {
	createNodeDriver,
	type NodeDriverOptions,
} from "./node-driver.js";
