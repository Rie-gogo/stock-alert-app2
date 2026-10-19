import { describe, it, expect, vi } from "vitest";
import mysql from "mysql2";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
vi.mock("./_core/sdk", () => ({ sdk: { verifySession: vi.fn() } }));
vi.mock("./db", () => ({ getUserByOpenId: vi.fn() }));
import {
  createExportHandler,
  makePage,
  snapshotValue,
  MAX_BYTES,
} from "./dataExport";
const now = Date.parse("2026-10-19T12:00:00Z");
function harness(options: any = {}) {
  const rows = options.rows ?? [
    { id: "1" },
    { id: "2" },
    { id: "3" },
    { id: "4" },
  ];
  const query = vi.fn(async (q: any, args: any[]) => {
    const sql = q.sql;
    if (sql === "SET SESSION tidb_snapshot = ''" && options.resetFailure)
      throw new Error("reset failed");
    if (sql.startsWith("SET")) return [[], []];
    if (sql.includes("VERSION()"))
      return [[{ version: options.mysql ? "8.0" : "8.0-TiDB" }], []];
    if (sql.startsWith("SHOW FULL"))
      return [
        options.composite
          ? [
              { Field: "id", Key: "PRI" },
              { Field: "other", Key: "PRI" },
            ]
          : [{ Field: options.pk ?? "id", Key: "PRI", Type: "int" }],
        [],
      ];
    if (sql.startsWith("SHOW CREATE"))
      return [[{ "Create Table": "CREATE TABLE test" }], []];
    if (sql.includes("COUNT(*)"))
      return [[{ count: "4", minKey: "1", maxKey: "4" }], []];
    if (options.wait) await options.wait;
    return [
      rows
        .filter(r => !sql.includes(" WHERE ") || +r.id > +args[0])
        .slice(0, Number(sql.match(/LIMIT (\d+)/)?.[1] ?? 501)),
      [],
    ];
  });
  const destroy = vi.fn();
  const execute = vi.fn(query.getMockImplementation()!);
  const connect = vi.fn(
    options.connect ?? (async () => ({ query, execute, destroy }) as any)
  );
  const handler = createExportHandler({
    authenticate: async () => ({ role: options.role ?? "admin" }),
    connect,
    enabledUntil: () =>
      options.until === undefined ? "2026-10-19T13:00:00Z" : options.until,
    now: () => now,
  });
  async function call(
    query: any = {},
    table = "rt_forward_shadow_trades",
    path = "/"
  ) {
    const headers: any = {};
    const res: any = {
      statusCode: 200,
      setHeader: (k: string, v: any) => {
        headers[k] = v;
      },
      status(n: number) {
        this.statusCode = n;
        return this;
      },
      type() {
        return this;
      },
      json(v: any) {
        this.body = v;
        return this;
      },
      send(v: any) {
        this.body = v;
        return this;
      },
    };
    await handler({ params: { table }, query, path } as any, res);
    return { ...res, headers };
  }
  return { call, query, execute, connect, destroy };
}
describe("temporary read-only export", () => {
  it.each(["user", "guest"])("rejects role %s before DB access", async role => {
    const h = harness({ role });
    expect((await h.call()).statusCode).toBe(403);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it.each(["", "invalid", "2026-10-19T11:59:59Z"])(
    "fails closed for expiry %s",
    async until => {
      const h = harness({ until });
      expect((await h.call()).statusCode).toBe(403);
      expect(h.connect).not.toHaveBeenCalled();
    }
  );
  it("rejects unlisted identifiers and invalid limits/cursors", async () => {
    const h = harness();
    expect((await h.call({}, "users")).statusCode).toBe(404);
    for (const query of [
      { limit: "501" },
      { limit: "0" },
      { after: "1 OR 1=1" },
      { snapshot: "bad" },
    ])
      expect((await h.call(query)).statusCode).toBe(400);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("paginates without gaps or duplicates and hashes the exact body", async () => {
    const h = harness();
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const response = await h.call({
        limit: "2",
        ...(after === null ? {} : { after }),
      });
      expect(response.headers["Cache-Control"]).toBe("no-store");
      const page = JSON.parse(
        Buffer.from(response.headers["X-Export-Page"], "base64url").toString(
          "utf8"
        )
      );
      const rows = response.body.trim().split("\n").map(JSON.parse);
      expect(page.sha256).toBe(makePage(rows, "id", 2).sha256);
      seen.push(...rows.map((r: any) => r.id));
      after = page.next;
    } while (after);
    expect(seen).toEqual(["1", "2", "3", "4"]);
    expect(h.destroy).toHaveBeenCalledTimes(2);
  });
  it("preserves lossless wire values", () => {
    const row = {
      id: "9007199254740993",
      decimal: "123.00000000000000001",
      date: "2026-10-19 12:01:02.123456",
      json: '{"n":9007199254740993}',
      bin: { $binary: "AP8=" },
      nullable: null,
    };
    expect(JSON.parse(makePage([row], "id", 500).body)).toEqual(row);
  });
  it("bounds rows and bytes without advancing past omitted rows", () => {
    expect(
      makePage(
        Array.from({ length: 501 }, (_, id) => ({ id: String(id) })),
        "id",
        500
      ).count
    ).toBe(500);
    const rows = [1, 2, 3].map(id => ({
      id: String(id),
      value: "x".repeat(MAX_BYTES / 2),
    }));
    const page = makePage(rows, "id", 500);
    expect(Buffer.byteLength(page.body)).toBeLessThanOrEqual(MAX_BYTES);
    expect(page.next).toBe("1");
    expect(() =>
      makePage([{ id: "1", value: "x".repeat(MAX_BYTES) }], "id", 500)
    ).toThrow("single row");
  });
  it("rejects parallel work and unlocks afterwards", async () => {
    let release!: () => void;
    const wait = new Promise<void>(r => {
      release = r;
    });
    const h = harness({ wait });
    const first = h.call();
    await vi.waitFor(() => expect(h.query).toHaveBeenCalled());
    expect((await h.call()).statusCode).toBe(429);
    release();
    await first;
    expect((await h.call()).statusCode).toBe(200);
  });
  it("applies and clears the same snapshot on every dedicated connection", async () => {
    const h = harness();
    const snapshot = "2026-10-19T11:59:00Z";
    for (let i = 0; i < 2; i++)
      expect(
        (await h.call({ snapshot })).headers["X-Export-Snapshot-Used"]
      ).toBe("true");
    expect(
      h.query.mock.calls.filter(
        ([q]) => q.sql === "SET SESSION tidb_snapshot = ?"
      )
    ).toHaveLength(2);
    expect(
      h.query.mock.calls.filter(
        ([q]) => q.sql === "SET SESSION tidb_snapshot = ''"
      )
    ).toHaveLength(2);
    expect(h.destroy).toHaveBeenCalledTimes(2);
  });
  it("never silently falls back from unsupported snapshots", async () => {
    const h = harness({ mysql: true });
    const result = await h.call({ snapshot: "2026-10-19T11:59:00Z" });
    expect(result.statusCode).toBe(409);
    expect(result.body.snapshotUsed).toBe(false);
    expect(h.query.mock.calls.some(([q]) => q.sql.startsWith("SELECT *"))).toBe(
      false
    );
  });
  it("rejects stale/future snapshots, accepts TSO", () => {
    expect(() => snapshotValue("2026-10-19T11:49:59Z", now)).toThrow();
    expect(() => snapshotValue("2026-10-19T12:00:01Z", now)).toThrow();
    const tso = (BigInt(now - 1000) << BigInt(18)).toString();
    expect(snapshotValue(tso, now)).toBe(tso);
  });
  it("returns metadata on the same connection and snapshot", async () => {
    const result = await harness().call(
      { snapshot: "2026-10-19T11:59:00Z" },
      "rt_forward_shadow_trades",
      "/metadata"
    );
    expect(result.body).toMatchObject({
      count: "4",
      minKey: "1",
      maxKey: "4",
      snapshotUsed: true,
    });
  });
});

describe("driver decoding", () => {
  it("decodes numeric and JSON wire text without Number conversion", async () => {
    const { losslessTypeCast } = await import("./dataExport");
    for (const type of ["LONGLONG", "NEWDECIMAL", "DATETIME", "JSON"]) {
      const string = vi.fn(() => "9007199254740993.000000");
      const next = vi.fn();
      expect(losslessTypeCast({ type, string, buffer: () => null }, next)).toBe(
        "9007199254740993.000000"
      );
      expect(next).not.toHaveBeenCalled();
      if (type === "JSON") expect(string).toHaveBeenCalledWith("utf8");
    }
  });
  it("encodes raw binary and preserves null/text", async () => {
    const { losslessTypeCast } = await import("./dataExport");
    const field = {
      type: "BLOB",
      string: () => null,
      buffer: () => Buffer.from([0, 255]),
    };
    expect(losslessTypeCast(field, () => Buffer.from([0, 255]))).toEqual({
      $binary: "AP8=",
    });
    expect(
      losslessTypeCast({ ...field, type: "BIT" }, () => undefined)
    ).toEqual({ $binary: "AP8=" });
    expect(losslessTypeCast(field, () => null)).toBe(null);
    expect(losslessTypeCast(field, () => "日本語")).toBe("日本語");
  });
});

describe("read-only authentication", () => {
  it("rechecks stored user on each call and never syncs or updates users", async () => {
    const { sdk } = await import("./_core/sdk");
    const { getUserByOpenId } = await import("./db");
    const { authenticateExportRequest } = await import("./dataExport");
    vi.mocked(sdk.verifySession).mockResolvedValue({
      openId: "admin-user",
      appId: "app",
      name: "user",
    });
    vi.mocked(getUserByOpenId)
      .mockResolvedValueOnce({ role: "admin" } as any)
      .mockResolvedValueOnce({ role: "user" } as any);
    const req = { headers: { cookie: "" } } as any;
    expect((await authenticateExportRequest(req))?.role).toBe("admin");
    expect((await authenticateExportRequest(req))?.role).toBe("user");
    expect(getUserByOpenId).toHaveBeenCalledTimes(2);
    vi.mocked(sdk.verifySession).mockResolvedValue(null);
    expect(await authenticateExportRequest(req)).toBeNull();
    expect(getUserByOpenId).toHaveBeenCalledTimes(2);
  });
});

describe("failure cleanup", () => {
  it("rejects composite primary keys", async () => {
    const h = harness({ composite: true });
    expect((await h.call()).statusCode).toBe(409);
    expect(h.destroy).toHaveBeenCalledOnce();
  });
  it("does not return data when snapshot reset fails", async () => {
    const h = harness({ resetFailure: true });
    expect(
      (await h.call({ snapshot: "2026-10-19T11:59:00Z" })).statusCode
    ).toBe(503);
    expect(h.destroy).toHaveBeenCalledOnce();
    expect((await h.call()).statusCode).toBe(200);
  });
  it("times out, destroys connection and releases the export lock", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ wait: new Promise(() => {}) });
      const pending = h.call();
      await vi.advanceTimersByTimeAsync(15_001);
      expect((await pending).statusCode).toBe(504);
      expect(h.destroy).toHaveBeenCalled();
      // Invalid table fails before query but after acquiring the now-free lock.
      expect((await h.call({}, "users")).statusCode).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("review regressions", () => {
  it("binds hostile cursors separately from SQL, independent of NO_BACKSLASH_ESCAPES", async () => {
    const after = "\u65e5\u672c\u8a9e\\' OR 1=1 -- ";
    const h = harness({ pk: "version_id", rows: [] });
    expect(
      (await h.call({ after, limit: "2" }, "rt_strategy_versions")).statusCode
    ).toBe(200);
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: "SELECT * FROM `rt_strategy_versions` WHERE `version_id` > ? ORDER BY `version_id` LIMIT 3",
      }),
      [after]
    );
    expect(
      h.query.mock.calls.some(([q]) => /SELECT \*|COUNT\(\*\)/.test(q.sql))
    ).toBe(false);
    await h.call({}, "rt_strategy_versions", "/metadata");
    expect(h.execute.mock.calls.some(([q]) => q.sql.includes("COUNT(*)"))).toBe(
      true
    );
  });
  it("uses ASCII header metadata and round-trips Japanese primary keys", async () => {
    const h = harness({
      pk: "version_id",
      rows: [
        { version_id: "\u65e5\u672c\u8a9e" },
        { version_id: "\u7d9a\u304d" },
      ],
    });
    const response = await h.call({ limit: "1" }, "rt_strategy_versions");
    expect(response.statusCode).toBe(200);
    for (const value of Object.values(response.headers))
      expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(
      JSON.parse(
        Buffer.from(response.headers["X-Export-Page"], "base64url").toString(
          "utf8"
        )
      )
    ).toMatchObject({
      first: "\u65e5\u672c\u8a9e",
      last: "\u65e5\u672c\u8a9e",
      next: "\u65e5\u672c\u8a9e",
    });
  });
  it("times out a stalled handshake, aborts it and releases busy; destroys late connections", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: any) => void;
      let signal!: AbortSignal;
      const destroy = vi.fn();
      const h = harness({
        connect: (s: AbortSignal) => {
          signal = s;
          return new Promise(r => {
            resolve = r;
          });
        },
      });
      const pending = h.call();
      await vi.advanceTimersByTimeAsync(1);
      expect((await h.call()).statusCode).toBe(429);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await pending).statusCode).toBe(504);
      expect(signal.aborted).toBe(true);
      expect((await h.call({}, "users")).statusCode).toBe(404);
      resolve({ destroy });
      await vi.advanceTimersByTimeAsync(0);
      expect(destroy).toHaveBeenCalledOnce();
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("destroys the default core connection while its handshake is still pending", async () => {
    vi.useFakeTimers();
    const raw = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      promise: vi.fn(),
    });
    const spy = vi.spyOn(mysql, "createConnection").mockReturnValue(raw as any);
    process.env.DATABASE_URL =
      "mysql://offline:offline@invalid.example/offline";
    try {
      const handler = createExportHandler({
        authenticate: async () => ({ role: "admin" }),
        enabledUntil: () => "2026-10-19T13:00:00Z",
        now: () => now,
      });
      const res: any = {
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      const pending = handler(
        {
          params: { table: "rt_strategy_versions" },
          query: {},
          path: "/",
        } as any,
        res
      );
      await vi.advanceTimersByTimeAsync(15_001);
      await pending;
      expect(raw.destroy).toHaveBeenCalledOnce();
      expect(raw.promise).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(504);
    } finally {
      spy.mockRestore();
      delete process.env.DATABASE_URL;
      vi.useRealTimers();
    }
  });
  it("decodes prepared fixed-width numbers through the binary driver reader", async () => {
    const { preparedTypeCast } = await import("./dataExport");
    for (const type of [
      "SHORT",
      "LONG",
      "LONGLONG",
      "FLOAT",
      "DOUBLE",
      "YEAR",
    ]) {
      const string = vi.fn(() => {
        throw new Error("text reader must not run");
      });
      expect(
        preparedTypeCast(
          { type, string, buffer: () => null },
          () => "9007199254740993"
        )
      ).toBe("9007199254740993");
      expect(string).not.toHaveBeenCalled();
    }
  });
});


describe("real mysql2 transport cleanup (no network)", () => {
  it.each(["handshake timeout", "query timeout", "handshake error", "query error"])(
    "%s destroys every transport before busy permits retries",
    async phase => {
      vi.useFakeTimers();
      const createConnection = mysql.createConnection.bind(mysql);
      const streams: Duplex[] = [];
      const cores: ReturnType<typeof mysql.createConnection>[] = [];
      const spy = vi.spyOn(mysql, "createConnection").mockImplementation(() => {
        // Neither side completes the handshake or responds; end() alone cannot
        // destroy this duplex because its readable side remains open.
        const stream = new Duplex({
          read() {},
          write(_chunk, _encoding, callback) { callback(); },
        });
        const raw = createConnection({ stream, connectTimeout: 0 });
        streams.push(stream);
        cores.push(raw);
        return raw;
      });
      vi.stubEnv("DATABASE_URL", "mysql://offline:offline@invalid.example/offline");
      try {
        const handler = createExportHandler({
          authenticate: async () => ({ role: "admin" }),
          enabledUntil: () => "2026-10-19T13:00:00Z",
          now: () => now,
        });
        const call = () => {
          const res: any = {
            setHeader: vi.fn(),
            status: vi.fn().mockReturnThis(),
            json: vi.fn(),
          };
          const done = handler({
            params: { table: "rt_strategy_versions" }, query: {}, path: "/",
          } as any, res);
          return { res, done };
        };
        for (let attempt = 0; attempt < 3; attempt++) {
          const pending = call();
          await vi.advanceTimersByTimeAsync(0);
          expect(streams.filter(s => !s.destroyed)).toHaveLength(1);
          const busy = call();
          await busy.done;
          expect(busy.res.status).toHaveBeenCalledWith(429);
          if (phase.startsWith("query")) {
            // Exercise the real PromiseConnection and queued query, bypassing
            // only the server handshake event; no protocol server is involved.
            cores[attempt].emit("connect");
            await vi.advanceTimersByTimeAsync(0);
          }
          if (phase.endsWith("error")) {
            streams[attempt].emit("error", new Error("offline failure"));
          } else {
            await vi.advanceTimersByTimeAsync(15_001);
          }
          await pending.done;
          expect(pending.res.status).toHaveBeenCalledWith(
            phase.endsWith("error") ? 503 : 504
          );
          expect(streams).toHaveLength(attempt + 1);
          expect(streams.every(s => s.destroyed)).toBe(true);
          expect(cores.every(c => (c as any).connectTimeout == null)).toBe(true);
        }
      } finally {
        for (const core of cores) core.destroy();
        for (const stream of streams) stream.destroy();
        spy.mockRestore();
        vi.unstubAllEnvs();
        vi.useRealTimers();
      }
    }
  );
});
