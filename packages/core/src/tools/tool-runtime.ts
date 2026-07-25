import type { McpClientLogger } from "../utils/mcp-client-logger.js";
import type { HevyClient } from "@hevy-mcp/hevy-client";
import {
	HEVY_CLIENT_NOT_INITIALIZED_ERROR,
	requireClient,
} from "../utils/tool-helpers.js";
import { withErrorHandling } from "../utils/error-handler.js";
import type { ExerciseTemplateCatalog } from "../utils/exercise-template-catalog.js";
import type { McpToolResponse } from "../utils/response-formatter.js";
import type { ToolTelemetryMetadata } from "../utils/tool-taxonomy.js";
import { memoizeObservationScope, type ToolObserver } from "../observation.js";
import { bucketCount, getResultTelemetry } from "../utils/result-telemetry.js";
import { resolveErrorPolicy } from "../utils/error-policy.js";
import type { SqlDriver } from "@hevy-mcp/warehouse/portable";

const STRUCTURAL_ARGUMENT_KEYS = [
	"page",
	"pageSize",
	"since",
	"workoutId",
	"routineId",
	"folderId",
	"exerciseTemplateId",
	"date",
	"startDate",
	"endDate",
	"updatedSince",
	"includeCustom",
	"limit",
	"offset",
	"refresh",
	"query",
	"primaryMuscleGroup",
] as const;

const PRESENCE_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
	"since",
	"workoutId",
	"routineId",
	"folderId",
	"exerciseTemplateId",
	"date",
	"startDate",
	"endDate",
	"updatedSince",
	"query",
	"primaryMuscleGroup",
] as const);

const NUMERIC_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
	"page",
	"pageSize",
	"limit",
	"offset",
] as const);

const BOOLEAN_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
	"includeCustom",
	"refresh",
]);

function createSafeInvocation(
	name: string,
	args: Record<string, unknown>,
	taxonomy: ToolTelemetryMetadata | undefined,
) {
	const argumentKeys = STRUCTURAL_ARGUMENT_KEYS.filter((key) => key in args);
	const argumentPresence: Record<string, true> = {};
	const numericArgumentBuckets: Record<
		string,
		ReturnType<typeof bucketCount>
	> = {};
	const booleanArguments: Record<string, boolean> = {};

	for (const key of argumentKeys) {
		const value = args[key];
		if (
			PRESENCE_ARGUMENT_KEYS.has(key) &&
			value !== null &&
			value !== undefined
		) {
			argumentPresence[key] = true;
		}
		if (NUMERIC_ARGUMENT_KEYS.has(key) && typeof value === "number") {
			numericArgumentBuckets[key] = bucketCount(value);
		}
		if (BOOLEAN_ARGUMENT_KEYS.has(key) && typeof value === "boolean") {
			booleanArguments[key] = value;
		}
	}

	return {
		name,
		taxonomy,
		argumentKeys,
		argumentPresence,
		numericArgumentBuckets,
		booleanArguments,
		argumentKeyCountBucket: bucketCount(Object.keys(args).length),
	};
}

export type ToolHandler<
	TParams extends Record<string, unknown> = Record<string, unknown>,
> = (args: TParams) => Promise<McpToolResponse>;

export type ToolHandlerFactory = <TParams extends Record<string, unknown>>(
	fn: ToolHandler<TParams>,
	context: string,
	metadata?: ToolTelemetryMetadata,
) => ToolHandler;
/**
 * Access to the local analytical copy of the account's history. Absent when
 * the server runs in pass-through mode with no warehouse configured, in
 * which case the warehouse tools are not registered at all.
 */
export interface WarehouseAccess {
	/** Read-only handle for queries. */
	readonly read: SqlDriver;
	/** Writable handle for sync. Absent if the warehouse is read-only. */
	readonly write?: SqlDriver;
	/** Performs a sync against Hevy; returns a human-readable summary. */
	sync?(mode: "auto" | "full"): Promise<Record<string, unknown>>;
}

export interface ToolRuntime {
	readonly client: HevyClient | null;
	readonly catalog: ExerciseTemplateCatalog;
	readonly logger?: McpClientLogger;
	readonly createHandler: ToolHandlerFactory;
	readonly warehouse?: WarehouseAccess;
	getClient(): HevyClient;
	getWarehouse(): WarehouseAccess;
}

export interface CreateToolRuntimeOptions {
	client: HevyClient | null;
	catalog: ExerciseTemplateCatalog;
	logger?: McpClientLogger;
	createHandler?: ToolHandlerFactory;
	observer?: ToolObserver;
	warehouse?: WarehouseAccess;
}

export const WAREHOUSE_NOT_CONFIGURED_ERROR =
	"No local warehouse is configured. Run the sync CLI, or start the server with a warehouse database path.";

export const defaultHandlerFactory: ToolHandlerFactory = <
	TParams extends Record<string, unknown>,
>(
	fn: ToolHandler<TParams>,
	context: string,
) => withErrorHandling(fn, context);

export function createToolRuntime({
	client,
	catalog,
	logger,
	createHandler = defaultHandlerFactory,
	observer,
	warehouse,
}: CreateToolRuntimeOptions): ToolRuntime {
	const createObservedHandler: ToolHandlerFactory = <
		TParams extends Record<string, unknown>,
	>(
		fn: ToolHandler<TParams>,
		context: string,
		metadata?: ToolTelemetryMetadata,
	) =>
		createHandler<TParams>(
			async (args: TParams) => {
				let scope;
				try {
					scope = memoizeObservationScope(
						observer?.start(createSafeInvocation(context, args, metadata)),
					);
				} catch {
					scope = undefined;
				}
				const startedAt = Date.now();
				let handlerPromise: Promise<McpToolResponse> | undefined;
				const invokeHandler = () => {
					handlerPromise ??= Promise.resolve().then(() => fn(args));
					return handlerPromise;
				};
				try {
					let runPromise: Promise<McpToolResponse>;
					if (scope) {
						try {
							runPromise = scope.run(invokeHandler);
						} catch {
							runPromise = invokeHandler();
						}
					} else {
						runPromise = invokeHandler();
					}
					const result = await runPromise.catch(invokeHandler);
					void scope?.finish({
						outcome: result.isError ? "returned_error" : "success",
						durationMs: Date.now() - startedAt,
						result: {
							isError: Boolean(result.isError),
							hasStructuredContent: result.structuredContent !== undefined,
							contentCountBucket: bucketCount(result.content.length),
							summary: getResultTelemetry(result),
						},
					});
					return result;
				} catch (error) {
					const policy = resolveErrorPolicy(error, "");
					void scope?.finish({
						outcome: "thrown_error",
						durationMs: Date.now() - startedAt,
						errorType: policy.type,
						error: policy.diagnostic,
					});
					throw error;
				}
			},
			context,
			metadata,
		);
	const observedHandlerFactory = observer
		? createObservedHandler
		: createHandler;
	return {
		client,
		catalog,
		logger,
		createHandler: observedHandlerFactory,
		warehouse,
		getClient: () => requireClient(client),
		getWarehouse: () => {
			if (!warehouse) throw new Error(WAREHOUSE_NOT_CONFIGURED_ERROR);
			return warehouse;
		},
	};
}

export { HEVY_CLIENT_NOT_INITIALIZED_ERROR };
