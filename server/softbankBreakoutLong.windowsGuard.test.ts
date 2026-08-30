import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const executor = readFileSync(new URL("../analysis/kabu_order_executor_v2.py", import.meta.url), "utf8");
const relay = readFileSync(new URL("../analysis/kabu_board_relay_v5_9.py", import.meta.url), "utf8");

describe("9984専用LONG Windows LIVE二重拒否", () => {
  for (const [name, source] of [["Executor", executor], ["relay", relay]] as const) {
    it(`${name}はDRY_RUNを維持し、9984 LIVE新規entryだけを明示拒否する`, () => {
      expect(source).toContain("DRY_RUN = True");
      expect(source).toContain("SOFTBANK_BREAKOUT_LONG_LIVE_APPROVED = False");
      expect(source).toContain('SOFTBANK_BREAKOUT_LONG_REASON_PREFIX = "ソフトバンクG専用10本高値更新LONG"');
      expect(source).toContain('instruction_type == "entry"');
      expect(source).toContain("and not DRY_RUN");
      expect(source).toContain("and not SOFTBANK_BREAKOUT_LONG_LIVE_APPROVED");
      expect(source).toContain("startswith(SOFTBANK_BREAKOUT_LONG_REASON_PREFIX)");
      expect(source).toContain('return False, "9984専用LONGはLIVE未承認: 新規注文を強制拒否"');
    });
  }
});
