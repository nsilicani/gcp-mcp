/**
 * Google Cloud MCP Server
 *
 * This server provides Model Context Protocol resources and tools for interacting
 * with Google Cloud services (Billing, Error Reporting, IAM, Logging, Monitoring, Profiler, Spanner, and Trace).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import dotenv from "dotenv";

// Import service modules
import {
  registerLoggingResources,
  registerLoggingTools,
} from "./services/logging/index.js";
import {
  registerSpannerResources,
  registerSpannerTools,
  registerSpannerQueryCountTool,
} from "./services/spanner/index.js";
import {
  registerMonitoringResources,
  registerMonitoringTools,
} from "./services/monitoring/index.js";
import { registerTraceService } from "./services/trace/index.js";
import {
  registerIamResources,
  registerIamTools,
} from "./services/iam/index.js";
import {
  registerErrorReportingResources,
  registerErrorReportingTools,
} from "./services/error-reporting/index.js";
import {
  registerProfilerResources,
  registerProfilerTools,
} from "./services/profiler/index.js";
import { registerBillingService } from "./services/billing/index.js";
import { registerPrompts } from "./prompts/index.js";
import { initGoogleAuth, authClient } from "./utils/auth.js";
import { registerResourceDiscovery } from "./utils/resource-discovery.js";
import { registerProjectTools } from "./utils/project-tools.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import crypto from "node:crypto";
import { logger } from "./utils/logger.js";

// Load environment variables
dotenv.config();

/**
 * Main function to start the MCP server
 */
async function main(): Promise<void> {
  // -------------------------
  // Error and shutdown handlers
  // -------------------------
  process.on("uncaughtException", (error) => logger.error(error));
  process.on("unhandledRejection", (reason, promise) =>
    logger.error(`Unhandled rejection at: ${promise}, reason: ${reason}`)
  );

  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully`);
    process.exit(0);
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // -------------------------
  // Debug environment variables
  // -------------------------
  if (process.env.DEBUG) {
    logger.debug("Environment variables:");
    logger.debug(`GOOGLE_APPLICATION_CREDENTIALS: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || "not set"}`);
    logger.debug(`GOOGLE_CLOUD_PROJECT: ${process.env.GOOGLE_CLOUD_PROJECT || "not set"}`);
    logger.debug(`GOOGLE_CLIENT_EMAIL: ${process.env.GOOGLE_CLIENT_EMAIL ? "set" : "not set"}`);
    logger.debug(`GOOGLE_PRIVATE_KEY: ${process.env.GOOGLE_PRIVATE_KEY ? "set" : "not set"}`);
    logger.debug(`LAZY_AUTH: ${process.env.LAZY_AUTH || "not set"}`);
    logger.debug(`DEBUG: ${process.env.DEBUG || "not set"}`);
  }

  try {
    logger.info("Starting Google Cloud MCP server...");

    // -------------------------
    // MCP Server setup
    // -------------------------
    const server = new McpServer(
      {
        name: "Google Cloud MCP",
        version: "0.1.0",
        description: "Model Context Protocol server for Google Cloud services",
      },
      { capabilities: { prompts: {}, resources: {}, tools: {} } }
    );

    const sessions = new Map<string, StreamableHTTPServerTransport>();

    // Lazy Google auth
    const lazyAuth = process.env.LAZY_AUTH !== "false";
    logger.info(`Initializing Google Cloud auth (lazy=${lazyAuth})`);
    if (!lazyAuth) {
      try {
        const auth = await initGoogleAuth();
        if (auth) logger.info("Google Cloud authentication initialized successfully");
        else logger.warn("Google Cloud auth not available yet, lazy loading enabled");
      } catch (err) {
        logger.warn(`Auth initialization warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // -------------------------
    // Register all resources and tools
    // -------------------------
    const serviceRegistrations = [
      () => { logger.info("Logging"); registerLoggingResources(server); registerLoggingTools(server); },
      () => { logger.info("Spanner"); registerSpannerResources(server); registerSpannerTools(server); registerSpannerQueryCountTool(server); },
      async () => { logger.info("Monitoring"); registerMonitoringResources(server); await registerMonitoringTools(server); },
      async () => { logger.info("Trace"); await registerTraceService(server); },
      () => { logger.info("IAM"); registerIamResources(server); registerIamTools(server); },
      () => { logger.info("Error Reporting"); registerErrorReportingResources(server); registerErrorReportingTools(server); },
      () => { logger.info("Profiler"); registerProfilerResources(server); registerProfilerTools(server); },
      () => { logger.info("Billing"); registerBillingService(server); },
      () => { logger.info("Project tools"); registerProjectTools(server); },
      () => { logger.info("Prompts"); registerPrompts(server); },
      async () => { logger.info("Resource discovery"); await registerResourceDiscovery(server); },
    ];

    for (const fn of serviceRegistrations) {
      try { await fn(); }
      catch (err) { logger.warn(`Error registering service/tool: ${err instanceof Error ? err.message : String(err)}`); }
    }

    // -------------------------
    // Transport setup
    // -------------------------
    const port = Number(process.env.PORT ?? 3001);
    const enableStdio = process.env.ENABLE_STDIO === "true";

    // Streamable HTTP transport (required for FastMCP)
    const httpServer = http.createServer(async (req, res) => {
      if (req.url !== "/mcp") {
        res.statusCode = 404;
        res.end();
        return;
      }

      try {
        // MCP clients send this header to identify the session
        const sessionId =
          req.headers["mcp-session-id"]?.toString() ??
          crypto.randomUUID();

        let transport = sessions.get(sessionId);

        // If this is a new session, create and register it
        if (!transport) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
          });

          sessions.set(sessionId, transport);
          await server.connect(transport);
        }

        // Handle the request using the SAME transport
        await transport.handleRequest(req, res);

        // Cleanup when the session ends
        res.on("close", () => {
          if ((transport as any).closed) {
            sessions.delete(sessionId);
          }
        });
      } catch (err) {
        logger.error(
          `MCP HTTP transport error: ${err instanceof Error ? err.message : String(err)
          }`
        );
        res.statusCode = 500;
        res.end();
      }
    });


    // Configure keep-alive for persistent MCP connections
    // Note: Setting to 0 causes immediate timeout. Use large values instead.
    // These control idle connection timeouts, NOT request processing timeouts
    const keepAliveMs = Number(process.env.KEEP_ALIVE_TIMEOUT ?? 300_000); // 5 minutes default
    httpServer.keepAliveTimeout = keepAliveMs;
    httpServer.headersTimeout = keepAliveMs + 10_000; // Always 10s more than keepAlive

    // Disable request timeout to allow long-running operations
    httpServer.timeout = 0; // 0 here DOES mean no timeout for active requests

    logger.info(`HTTP keep-alive configured: ${httpServer.keepAliveTimeout}ms idle timeout, no request timeout`);

    httpServer.listen(port, () => {
      logger.info(`MCP HTTP server listening on http://localhost:${port}/mcp`);
    });

    // Optional stdio transport for local Claude Desktop
    if (enableStdio) {
      const stdioTransport = new StdioServerTransport();
      await server.connect(stdioTransport);
      logger.info("Stdio transport enabled");
    }

    logger.info("MCP server started successfully");

    // -------------------------
    // Heartbeat / delayed auth
    // -------------------------
    let heartbeatCount = 0;
    setInterval(() => {
      heartbeatCount++;
      if (process.env.DEBUG) logger.debug(`Server heartbeat #${heartbeatCount}`);
      if (!authClient && heartbeatCount % 5 === 0) {
        initGoogleAuth()
          .then((auth) => {
            if (auth && !authClient) {
              logger.info("Google Cloud auth initialized (delayed)");
            }
          })
          .catch((authError) => {
            logger.debug(`Delayed auth check failed: ${authError instanceof Error ? authError.message : String(authError)}`);
          });
      }
    }, 30000);

  } catch (error) {
    logger.error(`Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      logger.error(error.stack);
    }
    logger.info("Server continuing to run despite startup errors");
  }
}

// Start the server
main();