import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { formatKioxiaShortGuardDryRunReport } from "./kioxiaShortGuardDryRunReport";

describe("285A両SHORTガード 16時DRY_RUN報告", () => {
  it("反転SHORT BPRと安全CB出来高の当日終了を集計する", () => {
    const result = formatKioxiaShortGuardDryRunReport([
      {
        candleTime: "09:55",
        guardType: "reversal_short_bpr",
        observedValue: "0.660000",
        thresholdValue: "0.700000",
        averageVolume: null,
        zeroVolumeBars: 0,
        detail: "285A反転SHORT当日終了: BPR=0.66",
        referencePrice: "2100.00",
      },
      {
        candleTime: "10:10",
        guardType: "safe_cb_volume",
        observedValue: "0.400000",
        thresholdValue: "0.450000",
        averageVolume: "5000.0000",
        zeroVolumeBars: 0,
        detail: "285A安全CB SHORT当日終了: 出来高比=0.400",
        referencePrice: "2050.00",
      },
    ]);

    expect(result.summary).toEqual({
      reversalShortBprBlocks: 1,
      safeCbVolumeBlocks: 1,
      suspectedMissingVolumeBlocks: 0,
    });
    expect(result.section).toContain("反転SHORT BPR<0.70当日終了: 1件");
    expect(result.section).toContain("安全CB 出来高比<0.45当日終了: 1件");
  });

  it("同一イベントを重複排除し、出来高ゼロ多数をデータ欠損疑いとして表示する", () => {
    const event = {
      candleTime: "09:44",
      guardType: "safe_cb_volume" as const,
      observedValue: "0.000000",
      thresholdValue: "0.450000",
      averageVolume: "0.0000",
      zeroVolumeBars: 20,
      detail: "285A安全CB SHORT当日終了: 出来高比=0.000",
      referencePrice: "1900.00",
    };
    const result = formatKioxiaShortGuardDryRunReport([event, { ...event }]);

    expect(result.summary.safeCbVolumeBlocks).toBe(1);
    expect(result.summary.suspectedMissingVolumeBlocks).toBe(1);
    expect(result.section).toContain("データ欠損疑い");
    expect(result.section).toContain("直前20本中20本が出来高ゼロ");
  });

  it("安全CB出来高ガードを4つの実エントリー経路すべてへ適用する", () => {
    const source = fs.readFileSync(new URL("./realtimeSimEngine.ts", import.meta.url), "utf8");
    const guardedEntrySites = source.match(/await shouldEndKioxiaSafeCbShortForVolume\(/g) ?? [];
    expect(guardedEntrySites).toHaveLength(4);
    expect(source).toContain("大台割れSHORT即エントリー: 出来高");
    expect(source).toContain("大台割れSHORT即エントリー(前足近接)");
    expect(source).toContain("大台押し目なし・強トレンドエントリー");
    expect(source).toContain("大台押し目確認後エントリー");
  });
});
