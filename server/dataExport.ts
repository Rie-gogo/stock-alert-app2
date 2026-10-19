import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import mysql from "mysql2";
import type { Connection } from "mysql2/promise";
import { sdk } from "./_core/sdk";
import { parse as parseCookie } from "cookie";
import { COOKIE_NAME } from "../shared/const";
import { getUserByOpenId } from "./db";

// Equivalent admin role check, without authenticateRequest's lastSignedIn writes/OAuth sync.
export async function authenticateExportRequest(req: Request) {
  const session = await sdk.verifySession(
    parseCookie(req.headers.cookie ?? "")[COOKIE_NAME]
  );
  return session ? ((await getUserByOpenId(session.openId)) ?? null) : null;
}

// Identifiers are exclusively code-owned. Add only reviewed single-column primary keys.
export const EXPORT_TABLES = {
  rt_forward_shadow_trades: "id",
  rt_strategy_versions: "version_id",
} as const;
export const MAX_ROWS = 500;
export const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
class ExportError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export function exportEnabled(until: string | undefined, now: number) {
  return (
    !!until &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      until
    ) &&
    Date.parse(until) > now
  );
}
export function snapshotValue(value: string, now: number): string {
  let time: number;
  if (/^\d{1,20}$/.test(value)) {
    time = Number(BigInt(value) >> BigInt(18));
  } else {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
      throw new ExportError(400, "snapshot must be a TSO or UTC ISO timestamp");
    time = Date.parse(value);
  }
  if (!Number.isFinite(time) || time > now || now - time > 600_000)
    throw new ExportError(
      400,
      "snapshot outside the 10 minute retention window"
    );
  return /^\d+$/.test(value)
    ? value
    : new Date(time).toISOString().replace("T", " ").replace("Z", "");
}
export function makePage(
  rows: Record<string, unknown>[],
  pk: string,
  limit: number
) {
  const lines: string[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const line = JSON.stringify(row) + "\n";
    const size = Buffer.byteLength(line);
    if (bytes + size > MAX_BYTES) {
      if (!lines.length)
        throw new ExportError(413, "single row exceeds page byte limit");
      break;
    }
    lines.push(line);
    bytes += size;
  }
  const body = lines.join("");
  const count = lines.length;
  const first = count ? String(rows[0][pk]) : null;
  const last = count ? String(rows[count - 1][pk]) : null;
  return {
    body,
    count,
    first,
    last,
    next: rows.length > count ? last : null,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}
export function losslessTypeCast(
  field: {
    type: string;
    string: (encoding?: string) => string | null;
    buffer: () => Buffer | null;
  },
  next: () => unknown
) {
  if (field.type === "JSON") return field.string("utf8");
  if (
    [
      "DECIMAL",
      "NEWDECIMAL",
      "TINY",
      "SHORT",
      "LONG",
      "LONGLONG",
      "INT24",
      "FLOAT",
      "DOUBLE",
      "YEAR",
      "DATE",
      "NEWDATE",
      "TIME",
      "TIME2",
      "DATETIME",
      "DATETIME2",
      "TIMESTAMP",
      "TIMESTAMP2",
    ].includes(field.type)
  )
    return field.string();
  if (["BIT", "GEOMETRY", "VECTOR"].includes(field.type)) {
    const value = field.buffer();
    return value === null ? null : { $binary: value.toString("base64") };
  }
  const value = next();
  return Buffer.isBuffer(value) ? { $binary: value.toString("base64") } : value;
}

// Binary prepared-statement rows use fixed-width numeric fields, unlike query().
export function preparedTypeCast(
  field: Parameters<typeof losslessTypeCast>[0],
  next: () => unknown
) {
  if (
    [
      "TINY",
      "SHORT",
      "LONG",
      "LONGLONG",
      "INT24",
      "FLOAT",
      "DOUBLE",
      "YEAR",
    ].includes(field.type)
  ) {
    const value = next();
    return value === null ? null : String(value);
  }
  return losslessTypeCast(field, next);
}

// mysql2 3.22.4 destroy() only calls close()/stream.end(), which can leave
// a half-open or handshaking socket alive. Close driver state/timers first,
// then force the transport closed, including PromiseConnection's core stream.
function destroyExportConnection(connection: { destroy: () => void }) {
  const core = connection as unknown as {
    stream?: { destroy: () => void };
    connection?: { stream?: { destroy: () => void } };
  };
  const stream = core.connection?.stream ?? core.stream;
  try {
    connection.destroy();
  } finally {
    stream?.destroy();
  }
}

type Dependencies = {
  authenticate: (req: Request) => Promise<{ role: string } | null>;
  connect: (signal: AbortSignal) => Promise<Connection>;
  enabledUntil: () => string | undefined;
  now: () => number;
};
const defaults: Dependencies = {
  authenticate: authenticateExportRequest,
  enabledUntil: () => process.env.DATA_EXPORT_ENABLED_UNTIL,
  now: Date.now,
  connect: async signal => {
    // A dedicated, never-pooled connection prevents snapshot/session state leakage.
    const url = process.env.DATABASE_URL;
    if (!url) throw new ExportError(503, "database unavailable");
    const raw = mysql.createConnection({
      uri: url,
      connectTimeout: TIMEOUT_MS,
      timezone: "Z",
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      typeCast: preparedTypeCast,
    });
    // The core connection is available before the handshake completes.
    return new Promise<Connection>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        raw.removeListener("connect", connected);
      };
      const failed = (error: Error) => {
        cleanup();
        destroyExportConnection(raw);
        reject(error);
      };
      const abort = () => {
        failed(new ExportError(504, "export timed out"));
      };
      const connected = () => {
        cleanup();
        resolve(raw.promise());
      };
      // Keep an error listener while the connection is being torn down.
      raw.once("error", failed);
      raw.once("connect", connected);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  },
};
export function createExportHandler(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  let busy = false;
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    let connection: Connection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acquired = false;
    const controller = new AbortController();
    try {
      const user = await deps.authenticate(req).catch(() => null);
      if (user?.role !== "admin") throw new ExportError(403, "admin required");
      const until = deps.enabledUntil();
      if (!exportEnabled(until, deps.now()))
        throw new ExportError(403, "export disabled or expired");
      if (busy) throw new ExportError(429, "export busy");
      busy = true;
      acquired = true;
      const scalar = (name: string) => {
        const v = req.query[name];
        if (v !== undefined && typeof v !== "string")
          throw new ExportError(400, "invalid query parameter");
        return v as string | undefined;
      };
      const table = req.params.table;
      if (!Object.hasOwn(EXPORT_TABLES, table))
        throw new ExportError(404, "table not allowed");
      const pk = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES];
      const after = scalar("after");
      const rawLimit = scalar("limit") ?? "500";
      if (!/^\d+$/.test(rawLimit) || +rawLimit < 1 || +rawLimit > MAX_ROWS)
        throw new ExportError(400, "limit must be 1..500");
      if (
        after !== undefined &&
        (after.length > 512 || (pk === "id" && !/^\d+$/.test(after)))
      )
        throw new ExportError(400, "invalid cursor");
      const requested = scalar("snapshot");
      const snapshot =
        requested === undefined
          ? undefined
          : snapshotValue(requested, deps.now());
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          if (connection) destroyExportConnection(connection);
          reject(new ExportError(504, "export timed out"));
        }, TIMEOUT_MS);
      });
      const work = async () => {
        const conn = await deps.connect(controller.signal);
        if (controller.signal.aborted) {
          destroyExportConnection(conn);
          throw new ExportError(504, "export timed out");
        }
        connection = conn;
        const query = async (sql: string, values: unknown[] = []) =>
          (await conn.query({ sql, timeout: TIMEOUT_MS }, values))[0] as Record<
            string,
            any
          >[];
        const execute = async (sql: string, values: string[] = []) =>
          (
            await conn.execute({ sql, timeout: TIMEOUT_MS }, values)
          )[0] as Record<string, any>[];
        await query("SET SESSION time_zone = '+00:00'");
        let applied = false;
        try {
          if (snapshot !== undefined) {
            const version = await query("SELECT VERSION() AS version");
            if (!String(version[0].version).toLowerCase().includes("tidb"))
              throw new ExportError(
                409,
                "snapshot unsupported; explicitly retry without snapshot for a live read"
              );
            await query("SET SESSION tidb_snapshot = ?", [snapshot]);
            applied = true;
          }
          res.setHeader("X-Export-Snapshot-Used", String(applied));
          res.setHeader("X-Export-Snapshot", requested ?? "live");
          const columns = await query(`SHOW FULL COLUMNS FROM \`${table}\``);
          const keys = columns.filter(c => c.Key === "PRI");
          if (keys.length !== 1 || keys[0].Field !== pk)
            throw new ExportError(
              409,
              "unsupported primary key (missing, composite, or changed)"
            );
          if (req.path.endsWith("/metadata")) {
            const ddl = await query(`SHOW CREATE TABLE \`${table}\``);
            const stats = await execute(
              `SELECT COUNT(*) AS count, MIN(\`${pk}\`) AS minKey, MAX(\`${pk}\`) AS maxKey FROM \`${table}\``
            );
            return {
              metadata: {
                table,
                primaryKey: pk,
                columns,
                ddl,
                ...stats[0],
                snapshotUsed: applied,
                snapshot: requested ?? null,
              },
            };
          }
          // mysql2 encodes Number binds as DOUBLE; target LIMIT compatibility is
          // unverified offline. rawLimit is digits-only and bounded to 1..500.
          const rows = await execute(
            `SELECT * FROM \`${table}\`${after === undefined ? "" : ` WHERE \`${pk}\` > ?`} ORDER BY \`${pk}\` LIMIT ${Number(rawLimit) + 1}`,
            after === undefined ? [] : [after]
          );
          return { page: makePage(rows, pk, +rawLimit) };
        } finally {
          if (applied) await query("SET SESSION tidb_snapshot = ''");
        }
      };
      const result = await Promise.race([work(), deadline]);
      if (result.metadata) {
        if (Buffer.byteLength(JSON.stringify(result.metadata)) > MAX_BYTES)
          throw new ExportError(413, "metadata exceeds page byte limit");
        res.json(result.metadata);
      } else if (result.page) {
        const { body, ...meta } = result.page;
        res.setHeader(
          "X-Export-Page",
          Buffer.from(JSON.stringify(meta), "utf8").toString("base64url")
        );
        res.type("application/x-ndjson").send(body);
      }
    } catch (error) {
      res.setHeader("X-Export-Snapshot-Used", "false");
      // Never log query errors, credentials, SQL parameters, or exported bodies.
      res.status(error instanceof ExportError ? error.status : 503).json({
        error: error instanceof ExportError ? error.message : "export failed",
        snapshotUsed: false,
      });
    } finally {
      if (timer) clearTimeout(timer);
      try {
        if (connection) destroyExportConnection(connection);
      } finally {
        if (acquired) busy = false;
      }
    }
  };
}
export function registerDataExport(app: Express) {
  const handler = createExportHandler();
  app.get("/api/admin/export", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const user = await defaults.authenticate(req).catch(() => null);
    if (
      user?.role !== "admin" ||
      !exportEnabled(defaults.enabledUntil(), Date.now())
    ) {
      res.status(403).json({ error: "admin required; export must be enabled" });
      return;
    }
    res.json({
      tables: EXPORT_TABLES,
      excluded:
        "Tables outside this allowlist, missing/composite primary keys are unsupported",
    });
  });
  app.get("/api/admin/export/:table/metadata", handler);
  app.get("/api/admin/export/:table", handler);
}
