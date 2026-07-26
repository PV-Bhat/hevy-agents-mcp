import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
	package: resolve(root, "packages/node/package.json"),
	plugin: resolve(root, "plugins/hevy/.codex-plugin/plugin.json"),
	pluginMcp: resolve(root, "plugins/hevy/.mcp.json"),
	marketplace: resolve(root, ".agents/plugins/marketplace.json"),
};

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function packageSpecifier(version) {
	return `hevy-agents-mcp@${version}`;
}

async function sync() {
	const pkg = await readJson(paths.package);
	const plugin = await readJson(paths.plugin);
	const pluginMcp = await readJson(paths.pluginMcp);
	const specifier = packageSpecifier(pkg.version);

	plugin.version = pkg.version;
	pluginMcp.mcpServers.hevy.args = ["-y", specifier];

	await Promise.all([
		writeJson(paths.plugin, plugin),
		writeJson(paths.pluginMcp, pluginMcp),
	]);
	console.log(`Synchronized distribution manifests to ${pkg.version}.`);
}

function requireValue(problems, condition, message) {
	if (!condition) problems.push(message);
}

async function check() {
	const [pkg, plugin, pluginMcp, marketplace] = await Promise.all([
		readJson(paths.package),
		readJson(paths.plugin),
		readJson(paths.pluginMcp),
		readJson(paths.marketplace),
	]);
	const problems = [];
	const specifier = packageSpecifier(pkg.version);
	const pluginServer = pluginMcp.mcpServers?.hevy;
	const marketplaceEntry = marketplace.plugins?.find(
		(entry) => entry.name === "hevy",
	);

	requireValue(problems, plugin.name === "hevy", "plugin name must be hevy");
	requireValue(
		problems,
		plugin.version === pkg.version,
		"plugin version must match hevy-agents-mcp",
	);
	requireValue(
		problems,
		plugin.mcpServers === "./.mcp.json",
		"plugin must reference .mcp.json",
	);
	requireValue(
		problems,
		pluginServer?.command === "npx",
		"plugin MCP command must be npx",
	);
	requireValue(
		problems,
		pluginServer?.args?.[1] === specifier,
		"plugin MCP package must be pinned to the release version",
	);
	requireValue(
		problems,
		pluginServer?.env_vars?.includes("HEVY_API_KEY"),
		"plugin must forward HEVY_API_KEY by name",
	);
	requireValue(
		problems,
		pluginServer?.env?.HEVY_API_KEY === undefined,
		"plugin must not embed HEVY_API_KEY",
	);
	requireValue(
		problems,
		pluginServer?.env?.HEVY_WAREHOUSE_DB === "auto",
		"plugin must enable the automatic local warehouse",
	);
	requireValue(
		problems,
		marketplaceEntry?.source?.path === "./plugins/hevy",
		"marketplace must point to ./plugins/hevy",
	);
	requireValue(
		problems,
		marketplaceEntry?.policy?.authentication === "ON_INSTALL",
		"marketplace authentication must be ON_INSTALL",
	);

	const serialized = JSON.stringify({ plugin, pluginMcp, marketplace });
	requireValue(
		problems,
		!/[A-Za-z]:\\\\Users\\\\|\/Users\/[^$]|\/home\/[^$]/.test(serialized),
		"distribution manifests must not contain machine-specific paths",
	);

	if (problems.length > 0) {
		throw new Error(
			`Distribution manifest check failed:\n- ${problems.join("\n- ")}`,
		);
	}
	console.log(`Distribution manifests are valid for ${pkg.version}.`);
}

const command = process.argv[2] ?? "check";
if (command === "sync") await sync();
else if (command === "check") await check();
else throw new Error(`Unknown command: ${command}`);
