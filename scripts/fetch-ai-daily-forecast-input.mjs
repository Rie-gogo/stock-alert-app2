#!/usr/bin/env node
/** Codex定期タスク用: 読取り専用D-1 inputをstdoutまたは--outへ出力する。 */
import { writeFile } from "node:fs/promises";
const baseUrl = (process.env.AI_DAILY_FORECAST_APP_URL || "https://stockalert-ulxu9jpf.manus.space").replace(/\/$/, "");
const tradeDate = process.argv[2] || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error("usage: node scripts/fetch-ai-daily-forecast-input.mjs YYYY-MM-DD [--out path]");
const input = encodeURIComponent(JSON.stringify({ 0: { json: { tradeDate } } }));
const response = await fetch(`${baseUrl}/api/trpc/trading.getAiDailyForecastInput?batch=1&input=${input}`, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`input endpoint: HTTP ${response.status}`);
const envelope = await response.json();
const result = envelope?.[0]?.result?.data?.json;
if (!result?.inputHash || !Array.isArray(result?.symbols) || result.symbols.length !== 10) throw new Error("input contract invalid: expected 10 symbols and inputHash");
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, "utf8"); else process.stdout.write(serialized);
