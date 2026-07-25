/* oxlint-disable typescript/unbound-method */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Workout } from "@hevy-mcp/hevy-client/types";
import type { HevyClient } from "@hevy-mcp/hevy-client";
import {
	formatWorkout,
	workoutEventsResponse,
} from "../utils/response-formatter.js";
import type { ExerciseTemplateCatalog } from "../utils/exercise-template-catalog.js";
import { createToolRuntime } from "./tool-runtime.js";
import { registerToolDefinition } from "./define-tool.js";
import { workoutToolDefinitions } from "./workouts.js";

function registerWorkoutTools(server: McpServer, client: HevyClient | null) {
	const runtime = createToolRuntime({
		client,
		catalog: {} as ExerciseTemplateCatalog,
	});
	for (const definition of workoutToolDefinitions) {
		registerToolDefinition(server, runtime, definition);
	}
}

function createMockServer() {
	const tool = vi.fn();
	const server = { tool, registerTool: tool } as unknown as McpServer;
	return { server, tool };
}

function getToolRegistration(toolSpy: ReturnType<typeof vi.fn>, name: string) {
	const match = toolSpy.mock.calls.find(([toolName]) => toolName === name);
	if (!match) {
		throw new Error(`Tool ${name} was not registered`);
	}
	const handler = match.at(-1) as (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
	}>;
	const config = match[1] as { outputSchema?: unknown } | undefined;
	return { outputSchema: config?.outputSchema, handler };
}

describe("registerWorkoutTools", () => {
	it("returns error responses when Hevy client is not initialized", async () => {
		const { server, tool } = createMockServer();
		registerWorkoutTools(server, null);

		const toolNames = [
			"get-workouts",
			"get-workout",
			"get-workout-count",
			"get-workout-events",
		];

		const toolArgs: Record<string, Record<string, unknown>> = {
			"get-workouts": { page: 1, pageSize: 5 },
			"get-workout": { workoutId: "workout-id" },
			"get-workout-count": {},
			"get-workout-events": {
				page: 1,
				pageSize: 5,
				since: "1970-01-01T00:00:00Z",
			},
			"create-workout": {
				title: "Workout",
				startTime: "2025-01-01T00:00:00Z",
				endTime: "2025-01-01T01:00:00Z",
				exercises: [],
			},
			"update-workout": {
				workoutId: "workout-id",
				title: "Workout",
				startTime: "2025-01-01T00:00:00Z",
				endTime: "2025-01-01T01:00:00Z",
				exercises: [],
			},
		};
		for (const name of toolNames) {
			const { handler } = getToolRegistration(tool, name);
			const response = await handler(toolArgs[name] ?? {});
			expect(response).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: expect.stringContaining(
							"API client not initialized. Please provide HEVY_API_KEY.",
						),
					},
				],
			});
		}
	});

	it("get-workout-events returns error response on client failure", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkoutEvents: vi
				.fn()
				.mockRejectedValue(new Error("Workout events endpoint failed")),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workout-events");

		const response = await handler({
			page: 1,
			pageSize: 5,
			since: "2025-01-01T00:00:00Z",
		});

		expect(vi.mocked(hevyClient.getWorkoutEvents)).toHaveBeenCalledWith({
			page: 1,
			pageSize: 5,
			since: "2025-01-01T00:00:00Z",
		});
		expect(response).toMatchObject({
			isError: true,
			content: [
				{
					type: "text",
					text: expect.stringContaining("The request failed unexpectedly"),
				},
			],
		});
	});

	it("get-workouts returns formatted workouts from the client", async () => {
		const { server, tool } = createMockServer();
		const workout: Workout = {
			id: "w1",
			title: "Morning Workout",
			description: "Great session",
			start_time: "2025-03-27T07:00:00Z",
			end_time: "2025-03-27T08:00:00Z",
			created_at: "2025-03-27T07:00:00Z",
			updated_at: "2025-03-27T07:10:00Z",
			exercises: [],
		};
		const hevyClient = {
			getWorkouts: vi.fn().mockResolvedValue({ workouts: [workout] }),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workouts");

		const response = await handler({ page: 1, pageSize: 5 });

		expect(vi.mocked(hevyClient.getWorkouts)).toHaveBeenCalledWith({
			page: 1,
			pageSize: 5,
		});

		const parsed = JSON.parse(response.content[0].text) as unknown[];
		expect(parsed).toEqual([formatWorkout(workout)]);
		expect(response.structuredContent).toEqual({
			workouts: parsed,
			page: 1,
			pageCount: undefined,
		});
	});

	it("formats updated and deleted workout events from the client", async () => {
		const { server, tool } = createMockServer();
		const workout = {
			id: "w1",
			title: "Morning Workout",
			start_time: "2025-03-27T07:00:00Z",
			end_time: "2025-03-27T08:00:00Z",
			exercises: [
				{
					index: 0,
					title: "Bench Press",
					exercise_template_id: "bench-press",
					sets: [],
					muscle_group: "chest",
				},
			],
		};
		const hevyClient = {
			getWorkoutEvents: vi.fn().mockResolvedValue({
				events: [
					{ type: "updated", workout },
					{
						type: "deleted",
						id: "deleted-workout",
						deleted_at: "2025-03-28T07:00:00Z",
					},
				],
			}),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler, outputSchema } = getToolRegistration(
			tool,
			"get-workout-events",
		);

		const response = await handler({
			page: 1,
			pageSize: 5,
			since: "2025-01-01T00:00:00Z",
		});

		expect(response.structuredContent).toEqual({
			events: [
				{ type: "updated", workout: formatWorkout(workout) },
				{
					type: "deleted",
					id: "deleted-workout",
					deletedAt: "2025-03-28T07:00:00Z",
				},
			],
			page: 1,
			pageCount: undefined,
		});
		expect(response.structuredContent).not.toHaveProperty(
			"events.0.workout.exercises.0.muscle_group",
		);
		expect(outputSchema).toBe(workoutEventsResponse.outputSchema);
		expect(() =>
			z
				.object(workoutEventsResponse.outputSchema)
				.parse(response.structuredContent),
		).not.toThrow();
	});

	it("rejects unsupported workout events without leaking payloads", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkoutEvents: vi.fn().mockResolvedValue({
				events: [
					{
						type: "mystery",
						id: "should-not-be-treated-as-deleted",
						secret: "sensitive-event-payload",
					},
				],
			}),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workout-events");

		const response = await handler({
			page: 1,
			pageSize: 5,
			since: "2025-01-01T00:00:00Z",
		});
		const responseText = response.content[0]?.text ?? "";

		expect(response.isError).toBe(true);
		expect(response.structuredContent).toBeUndefined();
		expect(responseText).toContain("The request failed unexpectedly");
		expect(responseText).not.toContain("mystery");
		expect(responseText).not.toContain("should-not-be-treated-as-deleted");
		expect(responseText).not.toContain("sensitive-event-payload");
	});

	it("returns structured empty lists for workouts and events", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkouts: vi.fn().mockResolvedValue({ workouts: [] }),
			getWorkoutEvents: vi
				.fn()
				.mockResolvedValueOnce({ events: [] })
				.mockResolvedValueOnce({}),
		} as unknown as HevyClient;
		registerWorkoutTools(server, hevyClient);

		const workouts = await getToolRegistration(tool, "get-workouts").handler({
			page: 1,
			pageSize: 5,
		});
		const events = await getToolRegistration(
			tool,
			"get-workout-events",
		).handler({
			page: 1,
			pageSize: 5,
			since: "1970-01-01T00:00:00Z",
		});
		const eventsWithoutEvents = await getToolRegistration(
			tool,
			"get-workout-events",
		).handler({
			page: 1,
			pageSize: 5,
			since: "1970-01-01T00:00:00Z",
		});

		expect(workouts.structuredContent).toMatchObject({
			workouts: [],
			page: 1,
		});
		expect(events.structuredContent).toMatchObject({
			events: [],
			page: 1,
		});
		expect(eventsWithoutEvents.structuredContent).toMatchObject({
			events: [],
			page: 1,
		});
		expect(workouts.content[0]?.text).toBe(
			"No workouts found for the specified parameters",
		);
		expect(events.content[0]?.text).toBe(
			"No workout events found for the specified parameters since 1970-01-01T00:00:00Z",
		);
		expect(eventsWithoutEvents.content[0]?.text).toBe(
			"No workout events found for the specified parameters since 1970-01-01T00:00:00Z",
		);
	});

	it("get-workout returns an empty response when workout is not found", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkout: vi.fn().mockResolvedValue(null),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workout");

		const response = await handler({ workoutId: "missing-id" });
		expect(vi.mocked(hevyClient.getWorkout)).toHaveBeenCalledWith("missing-id");
		expect(response.content[0]?.text).toBe(
			"Workout with ID missing-id not found",
		);
		expect(response.structuredContent).toEqual({ workout: null });
	});

	it("get-workout-count returns the numeric count from the client", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkoutCount: vi.fn().mockResolvedValue({ workout_count: 42 }),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workout-count");

		const response = await handler({});
		expect(vi.mocked(hevyClient.getWorkoutCount)).toHaveBeenCalledTimes(1);

		const parsed = JSON.parse(response.content[0].text) as unknown;
		expect(parsed).toEqual({ count: 42 });
		expect(response.structuredContent).toEqual(parsed);
	});

	it("get-workout-count returns 0 when workout_count is undefined", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkoutCount: vi.fn().mockResolvedValue({}),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workout-count");

		const response = await handler({});
		expect(vi.mocked(hevyClient.getWorkoutCount)).toHaveBeenCalledTimes(1);

		const parsed = JSON.parse(response.content[0].text) as unknown;
		expect(parsed).toEqual({ count: 0 });
	});

	it("get-workout-count returns 0 when data is null", async () => {
		const { server, tool } = createMockServer();
		const hevyClient = {
			getWorkoutCount: vi.fn().mockResolvedValue(null),
		} as unknown as HevyClient;

		registerWorkoutTools(server, hevyClient);
		const { handler } = getToolRegistration(tool, "get-workout-count");

		const response = await handler({});
		expect(vi.mocked(hevyClient.getWorkoutCount)).toHaveBeenCalledTimes(1);

		const parsed = JSON.parse(response.content[0].text) as unknown;
		expect(parsed).toEqual({ count: 0 });
	});

	// create-workout and update-workout are intentionally not registered in
	// this fork. Their absence is asserted in register.test.ts so an upstream
	// merge cannot quietly restore the ability to rewrite logged history.
});
