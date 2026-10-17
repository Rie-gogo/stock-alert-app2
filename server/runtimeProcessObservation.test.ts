import { describe, expect, it, vi } from "vitest";
import {
  getRuntimeProcessObservation,
  runtimeProcessObservationHandler,
} from "./runtimeProcessObservation";

describe("runtime process observation", () => {
  it("returns a fresh read-only process snapshot with a stable random instance id", () => {
    const first = getRuntimeProcessObservation();
    const second = getRuntimeProcessObservation();

    for (const snapshot of [first, second]) {
      expect(snapshot.rss).toBeGreaterThan(0);
      expect(snapshot.heapUsed).toBeGreaterThan(0);
      expect(snapshot.heapTotal).toBeGreaterThanOrEqual(snapshot.heapUsed);
      expect(snapshot.external).toBeGreaterThanOrEqual(0);
      expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(snapshot.observedAtMs).toBeGreaterThan(0);
      expect(snapshot.processInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(snapshot).not.toHaveProperty("pid");
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
    expect(second.processInstanceId).toBe(first.processInstanceId);
    expect(second.uptimeSeconds).toBeGreaterThanOrEqual(first.uptimeSeconds);
    expect(second.observedAtMs).toBeGreaterThanOrEqual(first.observedAtMs);
  });

  it("sets no-store headers and returns a newly observed payload", () => {
    const set = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    runtimeProcessObservationHandler(
      {} as never,
      {
        set,
        status,
      } as never
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        Pragma: "no-cache",
        "CDN-Cache-Control": "no-store",
        "Surrogate-Control": "no-store",
      })
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        heapTotal: expect.any(Number),
        external: expect.any(Number),
        uptimeSeconds: expect.any(Number),
        observedAtMs: expect.any(Number),
        processInstanceId: expect.any(String),
      })
    );
  });
});
