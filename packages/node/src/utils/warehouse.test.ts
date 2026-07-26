import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTO_WAREHOUSE_DIRECTORY,
	AUTO_WAREHOUSE_FILENAME,
	resolveWarehousePath,
} from "./warehouse.js";

describe("warehouse path configuration", () => {
	it("keeps the warehouse disabled when no path is configured", () => {
		expect(resolveWarehousePath({}, "/home/tester")).toBeUndefined();
	});

	it("resolves auto to a private file under the user home", () => {
		expect(
			resolveWarehousePath(
				{ HEVY_WAREHOUSE_DB: "auto" },
				"/home/tester",
			),
		).toBe(
			join(
				"/home/tester",
				AUTO_WAREHOUSE_DIRECTORY,
				AUTO_WAREHOUSE_FILENAME,
			),
		);
	});

	it("accepts auto case-insensitively and ignores surrounding whitespace", () => {
		expect(
			resolveWarehousePath(
				{ HEVY_WAREHOUSE_DB: "  AuTo  " },
				"/home/tester",
			),
		).toBe(
			join(
				"/home/tester",
				AUTO_WAREHOUSE_DIRECTORY,
				AUTO_WAREHOUSE_FILENAME,
			),
		);
	});

	it("preserves explicit path behavior", () => {
		expect(
			resolveWarehousePath({ HEVY_WAREHOUSE_DB: "./training.db" }),
		).toBe(resolve("./training.db"));
	});
});
