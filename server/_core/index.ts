import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createLegacyXRouter } from "../legacyX/routes";
import { runtimeHost, runtimePort, trustProxyValue, validateProductionRuntime } from "../legacyX/config";

async function startServer() {
  if (process.env.NODE_ENV === "production") validateProductionRuntime();

  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  // Nginx terminates TLS and forwards the client protocol/IP to the private Node listener.
  app.set("trust proxy", trustProxyValue());
  app.use("/api/v1", express.json({ limit: "1mb" }), express.urlencoded({ limit: "1mb", extended: true }), createLegacyXRouter());
  app.get("/health", (_req, res) => res.json({ ok: true, service: "legacy-x-backend" }));

  const port = runtimePort();
  const host = runtimeHost();
  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[shutdown] Received ${signal}; closing HTTP server`);
    const forceExit = setTimeout(() => {
      console.error("[shutdown] Timed out waiting for connections to close");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(error => {
      clearTimeout(forceExit);
      if (error) {
        console.error("[shutdown] HTTP server close failed", error);
        process.exit(1);
      }
      process.exit(exitCode);
    });
  };

  server.on("error", error => {
    console.error("[server] HTTP server error", error);
    shutdown("server error", 1);
  });
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("uncaughtException", error => {
    console.error("[process] Uncaught exception", error);
    shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", error => {
    console.error("[process] Unhandled rejection", error);
    shutdown("unhandledRejection", 1);
  });

  server.listen(port, host, () => {
    console.info(`[server] Listening on http://${host}:${port}`);
  });
}

startServer().catch(error => {
  console.error("[startup] Failed to start LEGACY-X API", error);
  process.exit(1);
});
