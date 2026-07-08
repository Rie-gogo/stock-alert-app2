import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { dailySimulationHandler, manualSimulationHandler, kabuPlanReminderHandler, rtDailyReportHandler, serverWarmupHandler } from "../scheduledHandlers";
import { restoreBuffersFromDb } from "../realtimeSimEngine";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // スケジュール実行エンドポイント（tRPCより前に登録）
  app.post("/api/scheduled/daily-simulation", dailySimulationHandler);
  // オーナー専用手動シミュレーションエンドポイント
  app.post("/api/admin/manual-simulation", manualSimulationHandler);
  // kabuステーション® Premiumプラン期限リマインド（毎日JST 9:00実行）
  app.post("/api/scheduled/kabu-plan-reminder", kabuPlanReminderHandler);
  // リアルタイムシミュレーション 大引け後レポート（毎平日JST 16:00実行）
  app.post("/api/scheduled/rt-daily-report", rtDailyReportHandler);
  // サーバーウォームアップ（毎平日JST 8:44実行）
  app.post("/api/scheduled/server-warmup", serverWarmupHandler);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // 起動時にDBから当日の1分足を読み込んでcandleBuffersを復元する
    // 取引時間中にサーバーが再起動した場合でも、既存の足からシグナル判定を即座に再開できる
    restoreBuffersFromDb().catch((err) =>
      console.error("[Startup] バッファ復元失敗:", err)
    );
    // 自動売買ブリッジの初期化（最後に処理したrt_trade IDを復元）
    import("../orderBridge").then(({ initOrderBridge }) =>
      initOrderBridge().catch((err) =>
        console.error("[Startup] OrderBridge初期化失敗:", err)
      )
    );
  });
}

startServer().catch(console.error);
