import { finalizeClosedTradeDateTail } from "../server/closedTradeDateTailDrain.ts";

const tradeDate = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate ?? "")) {
  throw new Error(`tradeDate must be YYYY-MM-DD: ${tradeDate}`);
}

const result = await finalizeClosedTradeDateTail({
  tradeDate,
  now: new Date(),
});
console.log(JSON.stringify(result, null, 2));

// DB clientのkeep-aliveでCLIが残らないよう、read/worker完了後は明示終了する。
process.exit(result.status === "complete" ? 0 : 2);
