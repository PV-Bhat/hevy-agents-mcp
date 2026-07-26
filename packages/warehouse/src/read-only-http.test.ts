import { describe, expect, it, vi } from "vitest";
import {
	createGuardedFetch,
	createReadOnlyHttp,
	HevyHttpStatusError,
	WriteAttemptError,
} from "./read-only-http.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("write guard", () => {
	const mutatingMethods = [
		"POST",
		"PUT",
		"PATCH",
		"DELETE",
		"post",
		"put",
		"patch",
		"delete",
	];

	it.each(mutatingMethods)(
		"blocks %s before any network call is made",
		(method) => {
			const fetchImpl = vi.fn<typeof fetch>();
			const guarded = createGuardedFetch(fetchImpl);
			expect(() =>
				guarded("https://api.hevyapp.com/v1/workouts", { method }),
			).toThrow(WriteAttemptError);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("allows GET through", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
		const guarded = createGuardedFetch(fetchImpl);
		await guarded("https://api.hevyapp.com/v1/workouts", { method: "GET" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("treats a missing method as GET", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}));
		const guarded = createGuardedFetch(fetchImpl);
		await guarded("https://api.hevyapp.com/v1/workouts");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("forces method GET even when the caller omits it on a Request", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}));
		const guarded = createGuardedFetch(fetchImpl);
		await guarded(new Request("https://api.hevyapp.com/v1/workouts"));
		const firstCall = fetchImpl.mock.calls[0] as unknown as
			| [input: RequestInfo | URL, init?: RequestInit]
			| undefined;
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected a fetch call");
		}
		expect(firstCall[1]?.method).toBe("GET");
	});

	it("names the blocked method and url in the error", () => {
		const error = new WriteAttemptError("POST", "https://x/y");
		expect(error.message).toContain("POST");
		expect(error.message).toContain("https://x/y");
		expect(error.message).toContain("read-only");
	});
});

describe("read-only http client", () => {
	it("sends the api-key header and builds the query string", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
		const http = createReadOnlyHttp({ apiKey: "test-key", fetchImpl });
		const result = await http.get("/v1/workouts", { page: 2, pageSize: 10 });
		expect(result).toEqual({ ok: true });
		const call = fetchImpl.mock.calls[0] as unknown as
			| [input: RequestInfo | URL, init?: RequestInit]
			| undefined;
		expect(call).toBeDefined();
		if (!call) {
			throw new Error("expected a fetch call");
		}
		const [input, init] = call;
		expect(input).toBeInstanceOf(URL);
		expect((input as URL).href).toBe(
			"https://api.hevyapp.com/v1/workouts?page=2&pageSize=10",
		);
		expect(new Headers(init?.headers).get("api-key")).toBe("test-key");
		expect(init?.method).toBe("GET");
	});

	it("retries a 429 and then succeeds", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({}, 429))
			.mockResolvedValueOnce(jsonResponse({ fine: 1 }));
		const http = createReadOnlyHttp({ apiKey: "k", fetchImpl, backoffMs: 1 });
		await expect(http.get("/v1/workouts")).resolves.toEqual({ fine: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("retries 5xx", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({}, 503))
			.mockResolvedValueOnce(jsonResponse({ fine: 1 }));
		const http = createReadOnlyHttp({ apiKey: "k", fetchImpl, backoffMs: 1 });
		await expect(http.get("/v1/workouts")).resolves.toEqual({ fine: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does not retry a 404", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
		const http = createReadOnlyHttp({ apiKey: "k", fetchImpl, backoffMs: 1 });
		await expect(http.get("/v1/workouts")).rejects.toThrow(
			HevyHttpStatusError,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("gives up after maxAttempts on persistent 429", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
		const http = createReadOnlyHttp({
			apiKey: "k",
			fetchImpl,
			backoffMs: 1,
			maxAttempts: 3,
		});
		await expect(http.get("/v1/workouts")).rejects.toThrow(
			HevyHttpStatusError,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
});
