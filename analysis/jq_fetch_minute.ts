/**
 * jq_fetch_minute.ts
 * J-Quants v2 の株価分足(/v2/equities/bars/minute)から、監視20銘柄の1分足を
 * 指定期間(直近約3か月)分まとめて取得し、analysis/jq_data/<symbol>.json に保存する。
 *
 * データ取得とバックテストを分離し、APIを叩き直さずに何度でも再検証できるようにする。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && JQUANTS_API_KEY=xxxx npx tsx analysis/jq_fetch_minute.ts 2026-03-01 2026-05-31
 */
import { TARGET_STOCKS } from "../shared/stocks";
import * as fs from "fs";
import * as path from "path";

const API_KEY = process.env.JQUANTS_API_KEY;
if (!API_KEY) {
  console.error("ERROR: JQUANTS_API_KEY env var is required");
  process.exit(1);
}

// J-Quants の銘柄コードは「4桁コード + 末尾0 = 5桁」。英数字コード(285A等)はそのまま+0。
function toJqCode(symbol: string): string {
  return `${symbol}0`;
}

interface JqBar {
  Date: string;  // YYYY-MM-DD
  Time: string;  // HH:mm
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
  for (let guard = 0; guard < 50; guard++) {
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
  const from = process.argv[2] ?? "2026-03-01";
  const to = process.argv[3] ?? "2026-05-31";
  const outDir = path.join(process.cwd(), "analysis", "jq_data");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[jq] Fetching 1m bars from ${from} to ${to} for ${TARGET_STOCKS.length} symbols...`);
  for (const s of TARGET_STOCKS) {
    const jqCode = toJqCode(s.symbol);
    try {
      const bars = await fetchSymbol(jqCode, from, to);
      const days = new Set(bars.map((b) => b.Date));
      fs.writeFileSync(path.join(outDir, `${s.symbol}.json`), JSON.stringify(bars), "utf8");
      console.log(`[jq] ${s.symbol} (${jqCode}) ${s.name}: ${bars.length} bars, ${days.size} days`);
    } catch (e) {
      console.warn(`[jq] ${s.symbol} (${jqCode}) FAILED: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`[jq] Done. Saved to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
