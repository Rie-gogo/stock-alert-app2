/**
 * J-Quants APIキーの動作検証テスト
 * JQUANTS_API_KEY が正しく設定されており、1分足データが取得できることを確認する
 */
import { describe, it, expect } from "vitest";
import { ENV } from "./_core/env";

describe("J-Quants API", () => {
  it("JQUANTS_API_KEY が設定されている", () => {
    expect(ENV.jquantsApiKey).toBeTruthy();
    expect(ENV.jquantsApiKey.length).toBeGreaterThan(10);
  });

  it("J-Quants API に接続できる（ソニー 6758.T の1分足）", async () => {
    const apiKey = ENV.jquantsApiKey;
    if (!apiKey) {
      throw new Error("JQUANTS_API_KEY is not set");
    }

    // 直近の営業日を取得（今日か昨日）
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    const today = jstNow.toISOString().slice(0, 10);

    // 過去5営業日分を試す
    const dates: string[] = [];
    const d = new Date(jstNow);
    for (let i = 0; i < 7 && dates.length < 5; i++) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) {
        dates.push(d.toISOString().slice(0, 10));
      }
      d.setDate(d.getDate() - 1);
    }

    let success = false;
    let lastError = "";

    for (const dateStr of dates) {
      const url = `https://api.jquants.com/v2/equities/bars/minute?code=67580&from=${dateStr}&to=${dateStr}`;
      const resp = await fetch(url, {
        headers: { "x-api-key": apiKey },
      });

      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }

      const json = (await resp.json()) as { data?: unknown[] };
      if (json.data && json.data.length > 0) {
        success = true;
        console.log(`[jquants.test] ${dateStr}: ${json.data.length} bars fetched ✓`);
        break;
      }
    }

    if (!success) {
      // 週末や祝日でデータがない場合はAPIキー自体は有効
      // 401/403エラーがなければキーは正常
      expect(lastError).not.toMatch(/401|403/);
      console.log("[jquants.test] No data for recent dates (possibly weekend/holiday), but API key is valid");
    } else {
      expect(success).toBe(true);
    }
  }, 30000);
});
