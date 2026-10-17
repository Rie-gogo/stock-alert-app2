import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

const PROCESS_INSTANCE_ID = randomUUID();

export type RuntimeProcessObservation = Readonly<{
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  uptimeSeconds: number;
  observedAtMs: number;
  processInstanceId: string;
}>;

/**
 * Read-only snapshot of the Node.js process that handled this request.
 * Memory values are bytes; this is not container-wide memory telemetry.
 */
export function getRuntimeProcessObservation(): RuntimeProcessObservation {
  const memory = process.memoryUsage();
  return Object.freeze({
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    uptimeSeconds: process.uptime(),
    observedAtMs: Date.now(),
    processInstanceId: PROCESS_INSTANCE_ID,
  });
}

export function runtimeProcessObservationHandler(
  _req: Request,
  res: Response
): void {
  res.set({
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "CDN-Cache-Control": "no-store",
    "Surrogate-Control": "no-store",
  });
  res.status(200).json(getRuntimeProcessObservation());
}
