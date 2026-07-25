/**
 * End-to-end check of the warehouse tools over the real MCP protocol.
 *
 *   node --env-file=.env scripts/try-warehouse-tools.mjs
 *
 * Connects an MCP client to an in-process server via an in-memory transport,
 * so tool registration, input schemas, response contracts and structured
 * output are all exercised exactly as a real client would.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHevyMcpServer } from "@hevy-mcp/core";
import { createHevyClient } from "@hevy-mcp/hevy-client";
import { openWarehouse } from "../packages/node/src/utils/warehouse.ts";

const apiKey = process.env.HEVY_API_KEY?.trim();
if (!apiKey) {
	console.error("HEVY_API_KEY missing; run with --env-file=.env");
	process.exit(1);
}
const dbPath = process.env.HEVY_WAREHOUSE_DB?.trim() ?? "hevy-warehouse.db";

const warehouse = openWarehouse({ path: dbPath, apiKey });
const server = createHevyMcpServer({
	warehouse,
	createClient: ({ onLog }) => createHevyClient({ apiKey, onLog }),
});

const [clientTransport, serverTransport] =
	InMemoryTransport.createLinkedPair();
const client = new Client({ name: "warehouse-smoke", version: "0.0.0" });
await Promise.all([
	client.connect(clientTransport),
	server.connect(serverTransport),
]);

function heading(text) {
	console.log(`\n${"=".repeat(70)}\n${text}\n${"=".repeat(70)}`);
}

async function call(name, args = {}) {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError) {
		console.log(`ERROR from ${name}:`);
		console.log(result.content?.map((c) => c.text).join("\n"));
		return null;
	}
	return result;
}

heading("TOOLS REGISTERED");
const { tools } = await client.listTools();
const warehouseTools = tools.filter(
	(t) =>
		t.name.includes("warehouse") ||
		t.name.includes("training-query") ||
		t.name.includes("training-schema") ||
		t.name.includes("training-history"),
);
console.log(`total tools: ${tools.length}`);
for (const tool of warehouseTools) console.log(`  - ${tool.name}`);

heading("get-warehouse-status");
const status = await call("get-warehouse-status");
console.log(JSON.stringify(status?.structuredContent, null, 2));

heading("describe-training-schema (first 30 lines)");
const described = await call("describe-training-schema");
const schemaText = described?.structuredContent?.schema ?? "";
console.log(schemaText.split("\n").slice(0, 30).join("\n"));
console.log(`... [${schemaText.split("\n").length} lines total]`);

heading("run-training-query — sessions per year, markdown");
const perYear = await call("run-training-query", {
	sql: `SELECT substr(local_date,1,4) AS year, COUNT(*) AS sessions,
	             ROUND(SUM(volume_kg)/1000) AS tonnes
	      FROM v_session GROUP BY year ORDER BY year`,
	format: "markdown",
});
console.log(perYear?.content?.map((c) => c.text).join("\n"));

heading("run-training-query — top 5 muscles by credited volume, csv");
const muscles = await call("run-training-query", {
	sql: `SELECT muscle_group, ROUND(SUM(credited_volume_kg)/1000) AS tonnes
	      FROM v_set_muscle GROUP BY muscle_group
	      ORDER BY tonnes DESC LIMIT 5`,
	format: "csv",
});
console.log(muscles?.content?.map((c) => c.text).join("\n"));

heading("run-training-query — structured JSON output");
const json = await call("run-training-query", {
	sql: "SELECT exercise_title, ROUND(MAX(e1rm_kg),1) AS best_e1rm FROM v_set WHERE exercise_title LIKE 'Squat (Barbell)%' GROUP BY exercise_title",
});
console.log(JSON.stringify(json?.structuredContent, null, 2));

heading("GUARD: a write must be refused");
const write = await client.callTool({
	name: "run-training-query",
	arguments: { sql: "DELETE FROM workout" },
});
console.log(`isError: ${write.isError}`);
console.log(write.content?.map((c) => c.text).join("\n"));

heading("GUARD: PRAGMA must be refused");
const pragma = await client.callTool({
	name: "run-training-query",
	arguments: { sql: "PRAGMA table_list" },
});
console.log(`isError: ${pragma.isError}`);
console.log(pragma.content?.map((c) => c.text).join("\n"));

heading("GUARD: row cap");
const capped = await call("run-training-query", {
	sql: "SELECT workout_id, exercise_title, reps FROM v_set",
	maxRows: 3,
});
console.log(JSON.stringify(capped?.structuredContent, null, 2));

heading("GUARD: bad column name must explain itself");
const badCol = await client.callTool({
	name: "run-training-query",
	arguments: { sql: "SELECT bodyweight FROM v_set LIMIT 1" },
});
console.log(badCol.content?.map((c) => c.text).join("\n"));

await client.close();
warehouse.close();
console.log("\nall checks complete");
