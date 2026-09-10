import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const files = [
  "shared/stocks.ts",
  "server/realtimeSimEngine.ts",
  "server/orderBridge.ts",
  "server/socionextConfirmedLong.ts",
  "server/sumcoBreakdownShort.ts",
  "server/softbankBreakoutLong.ts",
  "server/kioxiaConfirmedMorningLong.ts",
  "server/telOpenDirectionBreakout.ts",
  "server/taiyoCandidateB.ts",
  "server/discoOpeningShortForwardShadow.ts",
  "server/discoOpeningShortForwardShadowEngine.ts",
];

// このbaselineはWindows作業ツリーで固定されたため、既存9ファイルはCRLFでhash化されている。
// Git checkoutや本番buildのOSに左右されないよう、hash入力だけをその固定時の改行へ正規化する。
// 7291737で追加・変更した6146停止行は当時LFのまま混在していたため、その4行だけLFを維持する。
const LEGACY_CRLF_FILES = new Set([
  "shared/stocks.ts",
  "server/realtimeSimEngine.ts",
  "server/orderBridge.ts",
  "server/socionextConfirmedLong.ts",
  "server/sumcoBreakdownShort.ts",
  "server/softbankBreakoutLong.ts",
  "server/kioxiaConfirmedMorningLong.ts",
  "server/telOpenDirectionBreakout.ts",
  "server/taiyoCandidateB.ts",
]);

function isDiscoPauseBaselineLine(line) {
  return /ポジションB: 本採用SHORT/.test(line)
    || /LONG経路、他銘柄、データ受信には影響させない/.test(line)
    || /enableDiscoOpeningBreakShort: false/.test(line)
    || /notes: "ディスコ: 確認型10本高値更新LONG/.test(line);
}

function normalizeSourceForBaselineHash(file, body) {
  const lf = body.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!LEGACY_CRLF_FILES.has(file)) return Buffer.from(lf, "utf8");
  if (file !== "server/realtimeSimEngine.ts") {
    return Buffer.from(lf.replace(/\n/g, "\r\n"), "utf8");
  }

  const hasTrailingNewline = lf.endsWith("\n");
  const lines = (hasTrailingNewline ? lf.slice(0, -1) : lf).split("\n");
  const mixed = lines.map((line, index) => {
    const isLastWithoutNewline = index === lines.length - 1 && !hasTrailingNewline;
    if (isLastWithoutNewline) return line;
    return `${line}${isDiscoPauseBaselineLine(line) ? "\n" : "\r\n"}`;
  }).join("");
  return Buffer.from(mixed, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveGitSha() {
  for (const key of ["GIT_COMMIT_SHA", "COMMIT_SHA", "SOURCE_VERSION"]) {
    if (process.env[key]) return process.env[key];
  }
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    if (status.length > 0) return "unavailable";
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

const fileHashes = Object.fromEntries(files.map(file => {
  const body = readFileSync(resolve(root, file));
  return [file, sha256(normalizeSourceForBaselineHash(file, body))];
}));
const sourceTreeHash = sha256(
  Object.entries(fileHashes).map(([file, hash]) => `${file}:${hash}`).join("\n"),
);
const value = {
  gitSha: resolveGitSha(),
  sourceTreeHash,
  generatedAt: new Date().toISOString(),
  fileHashes,
};

writeFileSync(
  resolve(root, "server/generatedBuildIdentity.ts"),
  `// 自動生成ファイル。scripts/generate-build-identity.mjs以外で編集しない。\nexport const GENERATED_BUILD_IDENTITY = ${JSON.stringify(value, null, 2)} as const;\n`,
);
