/**
 * jq_fetch_extend.ts
 * 既存の analysis/jq_data/<symbol>.json に、追加期間のデータをマージして保存する。
 * 既存データ(2026-03-02〜2026-05-29)に加えて、2025-11-01〜2026-02-28を取得し結合する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && JQUANTS_API_KEY=xxxx npx tsx analysis/jq_fetch_extend.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import * as fs from "fs";
import * as path from "path";

const API_KEY = process.env.JQUANTS_API_KEY;
if (!API_KEY) {
  console.error("ERROR: JQUANTS_API_KEY env var is required");
  process.exit(1);
}

function toJqCode(symbol: string): string {
  return `${symbol}0`;
}

interface JqBar {
  Date: string;
  Time: string;
  Code: string;
  O: number;
  H: number;
  L: number;
  C: number;
  Vo: number;
  Va: number;
}

async function fetchSymbol(jqCode: string, from: string, to: string): Promise<JqBar[]> {
  const all: JqBar[] = [];
  let paginationKey: string | undefined = undefined;
  for (let guard = 0; guard < 100; guard++) {
    const params = new URLSearchParams({ code: jqCode, from, to });
    if (paginationKey) params.set("pagination_key", paginationKey);
    const url = `https://api.jquants.com/v2/equities/bars/minute?${params.toString()}`;
    const resp = await fetch(url, { headers: { "x-api-key": API_KEY as string } });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { data?: JqBar[]; pagination_key?: string | null };
    if (json.data) all.push(...json.data);
    if (json.pagination_key) {
      paginationKey = json.pagination_key;
      await new Promise((r) => setTimeout(r, 300));
    } else {
      break;
    }
  }
  return all;
}

async function main() {
  // 追加取得期間: 2025-11-01 〜 2026-02-28 (約70営業日)
  const newFrom = process.argv[2] ?? "2025-11-01";
  const newTo = process.argv[3] ?? "2026-02-28";
  const outDir = path.join(process.cwd(), "analysis", "jq_data");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[jq_extend] Fetching additional 1m bars from ${newFrom} to ${newTo} for ${TARGET_STOCKS.length} symbols...`);
  console.log(`[jq_extend] Will merge with existing data in ${outDir}`);

  let successCount = 0;
  let failCount = 0;

  for (const s of TARGET_STOCKS) {
    const jqCode = toJqCode(s.symbol);
    const outFile = path.join(outDir, `${s.symbol}.json`);

    try {
      // 既存データを読み込む
      let existingBars: JqBar[] = [];
      if (fs.existsSync(outFile)) {
        existingBars = JSON.parse(fs.readFileSync(outFile, "utf8"));
      }
      const existingKeys = new Set(existingBars.map(b => `${b.Date}_${b.Time}`));

      // 新しいデータを取得
      const newBars = await fetchSymbol(jqCode, newFrom, newTo);
      const newDays = new Set(newBars.map(b => b.Date));

      // 重複を除いてマージ（日付順でソート）
      const merged = [...existingBars];
      let addedCount = 0;
      for (const bar of newBars) {
        const key = `${bar.Date}_${bar.Time}`;
        if (!existingKeys.has(key)) {
          merged.push(bar);
          addedCount++;
        }
      }
      merged.sort((a, b) => {
        const da = `${a.Date}T${a.Time}`;
        const db = `${b.Date}T${b.Time}`;
        return da < db ? -1 : da > db ? 1 : 0;
      });

      const totalDays = new Set(merged.map(b => b.Date)).size;
      fs.writeFileSync(outFile, JSON.stringify(merged), "utf8");
      console.log(`[jq_extend] ${s.symbol} (${jqCode}) ${s.name}: +${addedCount} new bars (${newDays.size} new days), total ${merged.length} bars, ${totalDays} days`);
      successCount++;
    } catch (e) {
      console.warn(`[jq_extend] ${s.symbol} (${jqCode}) FAILED: ${(e as Error).message}`);
      failCount++;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n[jq_extend] Done. Success: ${successCount}, Failed: ${failCount}`);
  console.log(`[jq_extend] Saved to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
