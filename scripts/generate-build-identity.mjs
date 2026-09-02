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
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveGitSha() {
  for (const key of ["GIT_COMMIT_SHA", "COMMIT_SHA", "SOURCE_VERSION"]) {
    if (process.env[key]) return process.env[key];
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

const fileHashes = Object.fromEntries(files.map(file => {
  const body = readFileSync(resolve(root, file));
  return [file, sha256(body)];
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
