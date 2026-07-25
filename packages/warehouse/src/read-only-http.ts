/**
 * Hard gate: the warehouse sync path is physically incapable of writing
 * to the Hevy account. Every request goes through this client, and any
 * method other than GET throws before a connection is opened.
 *
 * This is the architectural guarantee behind "workouts are read-only" —
 * not a convention, a gate with tests asserting it.
 */

export class WriteAttemptError extends Error {
	constructor(method: string, url: string) {
		super(
			`Blocked non-GET request (${method} ${url}). ` +
				"The warehouse sync client is read-only by design.",
		);
		this.name = "WriteAttemptError";
	}
}

export interface ReadOnlyHttpOptions {
	apiKey: string;
	baseUrl?: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Max attempts per request on 429/5xx/network failure. */
	maxAttempts?: number;
	/** Base backoff delay in ms; doubles per retry. */
	backoffMs?: number;
	timeoutMs?: number;
}

export interface ReadOnlyHttp {
	/** Perform a GET against the Hevy API. Rejects any other method. */
	get(path: string, query?: Record<string, string | number>): Promise<unknown>;
}

const DEFAULT_BASE_URL = "https://api.hevyapp.com";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HevyHttpStatusError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
	) {
		super(`Hevy API responded ${status} for ${url}`);
		this.name = "HevyHttpStatusError";
	}
}

/**
 * The guard: a fetch wrapper that refuses everything except GET,
 * regardless of what any caller upstream asks for. Exported so the
 * guarantee is directly testable rather than only reachable through
 * the (already GET-only) public surface.
 */
export function createGuardedFetch(fetchImpl: typeof fetch): typeof fetch {
	return (input, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (method !== "GET") {
			throw new WriteAttemptError(method, url);
		}
		return fetchImpl(input, { ...init, method: "GET" });
	};
}

export function createReadOnlyHttp(options: ReadOnlyHttpOptions): ReadOnlyHttp {
	const {
		apiKey,
		baseUrl = DEFAULT_BASE_URL,
		fetchImpl = fetch,
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		backoffMs = DEFAULT_BACKOFF_MS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = options;

	const guardedFetch = createGuardedFetch(fetchImpl);

	return {
		async get(path, query = {}) {
			const url = new URL(path, baseUrl);
			for (const [key, value] of Object.entries(query)) {
				url.searchParams.set(key, String(value));
			}

			let lastError: unknown;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				try {
					const response = await guardedFetch(url, {
						method: "GET",
						headers: { "api-key": apiKey, accept: "application/json" },
						signal: AbortSignal.timeout(timeoutMs),
					});
					if (response.ok) return await response.json();
					// 4xx other than 429 will not improve on retry.
					if (
						response.status !== 429 &&
						response.status < 500
					) {
						throw new HevyHttpStatusError(response.status, url.href);
					}
					lastError = new HevyHttpStatusError(response.status, url.href);
				} catch (error) {
					if (error instanceof WriteAttemptError) throw error;
					if (
						error instanceof HevyHttpStatusError &&
						error.status !== 429 &&
						error.status < 500
					) {
						throw error;
					}
					lastError = error;
				}
				if (attempt < maxAttempts) {
					await sleep(backoffMs * 2 ** (attempt - 1));
				}
			}
			throw lastError;
		},
	};
}
