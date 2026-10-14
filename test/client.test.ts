import { describe, expect, it, vi } from "vitest";
import { NemiAuth } from "../src/auth";
import { NemiClient } from "../src/client";
import { NemiApiError, NemiError, NemiNetworkError, NemiRateLimitError } from "../src/errors";
import type { TokenSet } from "../src/types";
import { CLIENT_ID, DISCOVERY, formBody, json, mockFetch, noSleep } from "./helpers";

const API = "https://nemilab.com/api/v1";

function client(fetch: ReturnType<typeof mockFetch>["fetch"], extra: Record<string, unknown> = {}) {
  return new NemiClient({ accessToken: "nemi_oat_t", fetch, sleep: noSleep, ...extra });
}

describe("NemiClient basics", () => {
  it("accepts a token string, a provider or options", async () => {
    const { fetch, calls } = mockFetch((c) => (c.url === `${API}/me` ? json({ id: "u1", email_verified: true }) : undefined));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await new NemiClient("nemi_oat_a").me()).toEqual({ id: "u1", emailVerified: true });
      await new NemiClient({ getAccessToken: async () => "nemi_oat_b" }).me();
      expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer nemi_oat_a", "Bearer nemi_oat_b"]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(() => new NemiClient({})).toThrow(NemiError);
  });

  it("converts query params to snake_case and responses to camelCase", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.startsWith(`${API}/files?`)
        ? json({ folders: [{ id: "f1", name: "Docs" }], files: [{ id: "x", workspace_id: "w1", folder_id: null, created_at: "t" }] })
        : undefined,
    );
    const res = await client(fetch).files.list({ workspaceId: "w1", folderId: "f 1", limit: 10 });
    expect(calls[0]!.url).toBe(`${API}/files?workspace_id=w1&folder_id=f%201&limit=10`);
    expect(res.files[0]).toEqual({ id: "x", workspaceId: "w1", folderId: null, createdAt: "t" });
  });

  it("sends JSON bodies in snake_case and returns undefined for 204", async () => {
    const { fetch, calls } = mockFetch((c) => {
      if (c.method === "POST" && c.url === `${API}/calendar/events`) return json({ id: "e1", all_day: true }, 201);
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    const c = client(fetch);
    const ev = await c.calendar.events.create({ title: "Lunch", start: "2026-10-14T11:00:00Z", end: "2026-10-14T12:00:00Z", allDay: true });
    expect(ev).toEqual({ id: "e1", allDay: true });
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      title: "Lunch",
      start: "2026-10-14T11:00:00Z",
      end: "2026-10-14T12:00:00Z",
      all_day: true,
    });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    await expect(c.calendar.events.delete("e/1")).resolves.toBeUndefined();
    expect(calls[1]!.url).toBe(`${API}/calendar/events/e%2F1`);
  });

  it("round trips sheet cells without touching A1 keys", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url === `${API}/sheets/s1/cells` ? json({ id: "s1", title: "T", cells: { A1: "Total", B12: 42 } }) : undefined,
    );
    const sheet = await client(fetch).sheets.setCells("s1", { A1: "Total", B12: 42 });
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ cells: { A1: "Total", B12: 42 } });
    expect(calls[0]!.method).toBe("PATCH");
    expect(sheet.cells).toEqual({ A1: "Total", B12: 42 });
  });

  it("sends album photo ids as photo_ids", async () => {
    const { fetch, calls } = mockFetch((c) => (c.url === `${API}/gallery/albums/a1/photos` ? json({ ok: true }) : undefined));
    await client(fetch).gallery.albums.addPhotos("a1", ["p1", "p2"]);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ photo_ids: ["p1", "p2"] });
  });
});

describe("error mapping", () => {
  it("maps the API error shape, including required_scope", async () => {
    const { fetch } = mockFetch(() =>
      json({ error: { code: "insufficient_scope", message: "This call needs files.read.", required_scope: "files.read" } }, 403),
    );
    const err = await client(fetch).files.get("f1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NemiApiError);
    expect(err).toBeInstanceOf(NemiError);
    expect(err).toMatchObject({ status: 403, code: "insufficient_scope", requiredScope: "files.read", message: "This call needs files.read." });
  });

  it.each([
    [400, "invalid_request"],
    [401, "invalid_token"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "too_large"],
    [500, "server_error"],
  ])("maps HTTP %i with the server code", async (status, code) => {
    const { fetch } = mockFetch(() => json({ error: { code, message: "m" } }, status));
    await expect(client(fetch).docs.get("d")).rejects.toMatchObject({ status, code });
  });

  it("survives a non JSON error body", async () => {
    const { fetch } = mockFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(client(fetch).me()).rejects.toMatchObject({ name: "NemiApiError", status: 502, code: "server_error" });
  });
});

describe("retries", () => {
  it("retries 429 honoring Retry-After, then succeeds", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch(() =>
      ++n <= 2 ? json({ error: { code: "rate_limited", message: "slow down" } }, 429, { "Retry-After": "3" }) : json({ workspaces: [] }),
    );
    const c = client(fetch, { sleep: async (ms: number) => void sleeps.push(ms) });
    await expect(c.workspaces.list()).resolves.toEqual({ workspaces: [] });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("gives up after 2 retries with NemiRateLimitError", async () => {
    const { fetch, calls } = mockFetch(() => json({ error: { code: "rate_limited", message: "slow down" } }, 429, { "Retry-After": "7" }));
    const err = await client(fetch).workspaces.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NemiRateLimitError);
    expect(err).toBeInstanceOf(NemiApiError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 7 });
    expect(calls).toHaveLength(3);
  });

  it("does not wait for a Retry-After longer than the limit", async () => {
    const { fetch, calls } = mockFetch(() => json({}, 429, { "Retry-After": "3600" }));
    await expect(client(fetch).me()).rejects.toMatchObject({ retryAfter: 3600 });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors for GET only", async () => {
    let n = 0;
    const { fetch, calls } = mockFetch((c) => {
      if (c.method === "GET" && ++n <= 2) throw new TypeError("fetch failed");
      if (c.method === "POST") throw new TypeError("fetch failed");
      return json({ id: "u1" });
    });
    const c = client(fetch);
    await expect(c.me()).resolves.toEqual({ id: "u1" });
    expect(calls.filter((x) => x.method === "GET")).toHaveLength(3);
    await expect(c.docs.create({ title: "x" })).rejects.toBeInstanceOf(NemiNetworkError);
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });
});

describe("automatic refresh", () => {
  function setup(tokens: TokenSet) {
    let rotation = 0;
    const onTokens = vi.fn();
    const mock = mockFetch((c) => {
      if (c.url === DISCOVERY.token_endpoint) {
        rotation++;
        return json({ access_token: `nemi_oat_${rotation}`, token_type: "Bearer", expires_in: 3600, refresh_token: `nemi_ort_${rotation}` });
      }
      if (c.url.startsWith(API)) {
        return c.headers.authorization === "Bearer nemi_oat_old"
          ? json({ error: { code: "invalid_token", message: "expired" } }, 401)
          : json({ id: "u1" });
      }
      return undefined;
    });
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mock.fetch });
    const c = new NemiClient({ tokens, auth, onTokens, sleep: noSleep });
    const tokenCalls = () => mock.calls.filter((x) => x.url === DISCOVERY.token_endpoint);
    return { c, onTokens, tokenCalls, calls: mock.calls };
  }

  it("refreshes once on 401 even with parallel calls, and reports new tokens", async () => {
    const { c, onTokens, tokenCalls } = setup({ accessToken: "nemi_oat_old", tokenType: "Bearer", refreshToken: "nemi_ort_old" });
    const results = await Promise.all([c.me(), c.me(), c.workspaces.list()]);
    expect(results[0]).toEqual({ id: "u1" });
    expect(tokenCalls()).toHaveLength(1);
    expect(formBody(tokenCalls()[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "nemi_ort_old" });
    expect(onTokens).toHaveBeenCalledTimes(1);
    expect(onTokens.mock.calls[0]![0]).toMatchObject({ accessToken: "nemi_oat_1", refreshToken: "nemi_ort_1" });
    expect(c.tokens?.refreshToken).toBe("nemi_ort_1");
  });

  it("refreshes before the request when the token is about to expire", async () => {
    const { c, tokenCalls, calls } = setup({
      accessToken: "nemi_oat_old",
      tokenType: "Bearer",
      refreshToken: "nemi_ort_old",
      expiresAt: Date.now() + 10_000,
    });
    await c.me();
    expect(tokenCalls()).toHaveLength(1);
    const apiCalls = calls.filter((x) => x.url.startsWith(API));
    expect(apiCalls.map((x) => x.headers.authorization)).toEqual(["Bearer nemi_oat_1"]);
  });

  it("does not loop when the refreshed token is refused too", async () => {
    const mock = mockFetch((c) => {
      if (c.url === DISCOVERY.token_endpoint) return json({ access_token: "nemi_oat_still_bad", refresh_token: "nemi_ort_2" });
      if (c.url.startsWith(API)) return json({ error: { code: "invalid_token", message: "revoked" } }, 401);
      return undefined;
    });
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mock.fetch });
    const c = new NemiClient({ tokens: { accessToken: "a", tokenType: "Bearer", refreshToken: "r" }, auth, sleep: noSleep });
    await expect(c.me()).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    expect(mock.calls.filter((x) => x.url === DISCOVERY.token_endpoint)).toHaveLength(1);
  });

  it("does not refresh without a refresh token", async () => {
    const { fetch } = mockFetch(() => json({ error: { code: "invalid_token", message: "expired" } }, 401));
    await expect(client(fetch).me()).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("file upload", () => {
  function uploadMock() {
    return mockFetch((c) => {
      if (c.url === `${API}/files/uploads` && c.method === "POST") {
        return json({ upload_id: "up_1", upload_url: "https://storage.example/put?sig=abc", method: "PUT", expires_at: "t" });
      }
      if (c.url === "https://storage.example/put?sig=abc" && c.method === "PUT") return new Response(null, { status: 200 });
      if (c.url === `${API}/files/uploads/up_1/complete` && c.method === "POST") {
        return json({ id: "f1", name: "a.txt", size: 5, type: "text/plain", workspace_id: "w1", folder_id: "d1", created_at: "t" });
      }
      return undefined;
    });
  }

  it("does create, PUT and complete with a Uint8Array", async () => {
    const { fetch, calls } = uploadMock();
    const file = await client(fetch).files.upload(new TextEncoder().encode("hello"), {
      workspaceId: "w1",
      folderId: "d1",
      name: "a.txt",
      type: "text/plain",
    });
    expect(file).toMatchObject({ id: "f1", workspaceId: "w1", folderId: "d1" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/files/uploads`,
      "PUT https://storage.example/put?sig=abc",
      `POST ${API}/files/uploads/up_1/complete`,
    ]);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ workspace_id: "w1", folder_id: "d1", name: "a.txt", type: "text/plain", size: 5 });
    const put = calls[1]!;
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers["content-type"]).toBe("text/plain");
    expect(new TextDecoder().decode(put.body as Uint8Array)).toBe("hello");
  });

  it("takes size and type from a Blob", async () => {
    const { fetch, calls } = uploadMock();
    await client(fetch).files.upload(new Blob(["hey!"], { type: "text/markdown" }), { workspaceId: "w1", name: "n.md" });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ size: 4, type: "text/markdown" });
    expect(calls[1]!.body).toBeInstanceOf(Blob);
  });

  it("buffers a ReadableStream", async () => {
    const { fetch, calls } = uploadMock();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("he"));
        controller.enqueue(new TextEncoder().encode("llo"));
        controller.close();
      },
    });
    await client(fetch).files.upload(stream, { workspaceId: "w1", name: "s.bin" });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ size: 5 });
    expect(new TextDecoder().decode(calls[1]!.body as Uint8Array)).toBe("hello");
  });

  it("fails clearly when the PUT fails", async () => {
    const { fetch } = mockFetch((c) => {
      if (c.url === `${API}/files/uploads`) return json({ upload_id: "u", upload_url: "https://s.example/x", method: "PUT", expires_at: "t" });
      if (c.method === "PUT") return new Response("denied", { status: 403 });
      return undefined;
    });
    await expect(client(fetch).files.upload(new Uint8Array([1]), { workspaceId: "w", name: "x" })).rejects.toMatchObject({
      status: 403,
      code: "upload_failed",
    });
  });

  it("uploads a photo as multipart form data", async () => {
    const { fetch, calls } = mockFetch((c) => (c.url === `${API}/gallery/photos` ? json({ id: "p1", thumbnail_url: "u" }, 201) : undefined));
    const photo = await client(fetch).gallery.photos.upload(new Uint8Array([0xff, 0xd8, 0xff]), {
      workspaceId: "w1",
      name: "a.jpg",
      type: "image/jpeg",
    });
    expect(photo).toEqual({ id: "p1", thumbnailUrl: "u" });
    const body = calls[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("workspace_id")).toBe("w1");
    const file = body.get("file") as File;
    expect(file.name).toBe("a.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
  });
});

describe("cursor iteration", () => {
  it("follows next_cursor until it is null", async () => {
    const pages: Record<string, unknown> = {
      start: { photos: [{ id: "p1" }, { id: "p2" }], next_cursor: "c2" },
      c2: { photos: [{ id: "p3" }], next_cursor: "c3" },
      c3: { photos: [], next_cursor: "c4" },
      c4: { photos: [{ id: "p4" }], next_cursor: null },
    };
    const { fetch, calls } = mockFetch((c) => {
      if (!c.url.startsWith(`${API}/gallery/photos`)) return undefined;
      const cursor = new URL(c.url).searchParams.get("cursor") ?? "start";
      return json(pages[cursor]);
    });
    const ids: string[] = [];
    for await (const photo of client(fetch).gallery.photos.iterate({ workspaceId: "w1", favorites: true, limit: 2 })) {
      ids.push(photo.id);
    }
    expect(ids).toEqual(["p1", "p2", "p3", "p4"]);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toBe(`${API}/gallery/photos?workspace_id=w1&favorites=true&limit=2`);
    expect(calls[1]!.url).toContain("cursor=c2");
  });

  it("can stop early", async () => {
    const { fetch, calls } = mockFetch(() => json({ photos: [{ id: "a" }, { id: "b" }], next_cursor: "more" }));
    for await (const photo of client(fetch).gallery.photos.iterate()) {
      expect(photo.id).toBe("a");
      break;
    }
    expect(calls).toHaveLength(1);
  });
});
