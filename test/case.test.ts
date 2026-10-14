import { describe, expect, it } from "vitest";
import { camelToSnakeKey, snakeToCamelKey, toCamel, toSnake } from "../src/case";

describe("case conversion", () => {
  it("converts single keys", () => {
    expect(camelToSnakeKey("workspaceId")).toBe("workspace_id");
    expect(camelToSnakeKey("photoIds")).toBe("photo_ids");
    expect(camelToSnakeKey("name")).toBe("name");
    expect(snakeToCamelKey("next_cursor")).toBe("nextCursor");
    expect(snakeToCamelKey("email_verified")).toBe("emailVerified");
    expect(snakeToCamelKey("id")).toBe("id");
  });

  it("leaves non identifier keys alone", () => {
    for (const k of ["A1", "B12", "AA100", "Content-Type", "x-y", "_private", "1abc"]) {
      expect(camelToSnakeKey(k)).toBe(k);
      expect(snakeToCamelKey(k)).toBe(k);
    }
  });

  it("converts nested objects and arrays both ways", () => {
    const wire = {
      next_cursor: "c2",
      photos: [{ id: "p1", captured_at: "2026-01-01T00:00:00Z", thumbnail_url: "https://x", favorite: false }],
    };
    const ts = toCamel(wire);
    expect(ts).toEqual({
      nextCursor: "c2",
      photos: [{ id: "p1", capturedAt: "2026-01-01T00:00:00Z", thumbnailUrl: "https://x", favorite: false }],
    });
    expect(toSnake(ts)).toEqual(wire);
  });

  it("never converts keys inside cells", () => {
    const body = { cells: { A1: "Name", B12: 42, total_sum: 1, someKey: true } };
    expect(toSnake(body)).toEqual(body);
    expect(toCamel(body)).toEqual(body);
  });

  it("keeps non plain values as they are", () => {
    const date = new Date(0);
    const bytes = new Uint8Array([1, 2]);
    const out = toSnake<{ created_at: Date; raw_bytes: Uint8Array; nothing: null }>({ createdAt: date, rawBytes: bytes, nothing: null });
    expect(out.created_at).toBe(date);
    expect(out.raw_bytes).toBe(bytes);
    expect(out.nothing).toBeNull();
  });
});
