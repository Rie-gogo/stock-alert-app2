export type KioxiaShortGuardPersistedEvent = {
  candleTime: string;
  guardType: "reversal_short_bpr" | "safe_cb_volume";
  observedValue: number | string;
  thresholdValue: number | string;
  averageVolume: number | string | null;
  zeroVolumeBars: number;
  detail: string | null;
  referencePrice: number | string;
};

export type KioxiaShortGuardDryRunSummary = {
  reversalShortBprBlocks: number;
  safeCbVolumeBlocks: number;
  suspectedMissingVolumeBlocks: number;
};

export function formatKioxiaShortGuardDryRunReport(
  persistedEvents: KioxiaShortGuardPersistedEvent[] = [],
): { summary: KioxiaShortGuardDryRunSummary; section: string } {
  const eventsByIdentity = new Map<string, KioxiaShortGuardPersistedEvent>();
  for (const event of persistedEvents) {
    eventsByIdentity.set(`${event.candleTime}|${event.guardType}`, event);
  }
  const events = Array.from(eventsByIdentity.values()).sort((a, b) => a.candleTime.localeCompare(b.candleTime));
  const reversalShortBprBlocks = events.filter(event => event.guardType === "reversal_short_bpr").length;
  const safeCbVolumeBlocks = events.filter(event => event.guardType === "safe_cb_volume").length;
  const suspectedMissingVolumeBlocks = events.filter(event =>
    event.guardType === "safe_cb_volume" && event.zeroVolumeBars >= 10,
  ).length;

  const eventLines = events.map(event => {
    const label = event.guardType === "reversal_short_bpr" ? "反転SHORT BPR" : "安全CB 出来高";
    const dataQuality = event.guardType === "safe_cb_volume" && event.zeroVolumeBars >= 10
      ? ` / データ欠損疑い（直前20本中${event.zeroVolumeBars}本が出来高ゼロ）`
      : "";
    return `  [${event.candleTime}] ${label}当日終了 @${Number(event.referencePrice).toLocaleString()}円: ${event.detail ?? `観測=${event.observedValue}, 閾値=${event.thresholdValue}`}${dataQuality}`;
  });

  const summary = { reversalShortBprBlocks, safeCbVolumeBlocks, suspectedMissingVolumeBlocks };
  const section = `
【285A SHORTガード DRY_RUN監視】
  反転SHORT BPR<0.70当日終了: ${reversalShortBprBlocks}件
  安全CB 出来高比<0.45当日終了: ${safeCbVolumeBlocks}件（データ欠損疑い:${suspectedMissingVolumeBlocks}件）
${eventLines.length > 0 ? eventLines.join("\n") : "  （当日終了ガード発動なし）"}
  注: 最初の適格候補を拒否した日は同じSHORT経路を再探索しません。全取引はDRY_RUNです。
`;
  return { summary, section };
}
