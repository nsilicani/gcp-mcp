/**
 * Authentication utilities for Google Cloud services
 */
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import { configManager } from "./config.js";
import { stateManager } from "./state-manager.js";
import { logger } from "./logger.js";

// Global auth client that can be reused
// Exported to allow checking auth status from other modules
export let authClient: GoogleAuth | null = null;

/**
 * Initialises Google Cloud authentication using either:
 * 1. GOOGLE_APPLICATION_CREDENTIALS environment variable pointing to a service account file
 * 2. GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY environment variables
 *
 * This function supports lazy loading - it won't fail if credentials aren't available yet,
 * allowing the server to start without authentication and defer it until needed.
 *
 * Authentication is required for operation but can be lazy-loaded when first needed rather than
 * at startup, which helps prevent timeouts with Smithery.
 *
 * @param requireAuth If true, will throw an error if authentication fails. If false, will return null.
 * @returns Promise resolving to the authenticated GoogleAuth client or null if authentication isn't available
 */
export async function initGoogleAuth(
  requireAuth = false,
): Promise<GoogleAuth | null> {
  const lazyAuth = process.env.LAZY_AUTH !== "false";

  if (lazyAuth && !requireAuth) {
    logger.info("Lazy authentication enabled - deferring authentication");
  }

  try {
    // Reuse client if already created
    if (authClient) {
      return authClient;
    }

    // 1️⃣ Explicit credentials (legacy / CI / local JSON key)
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      logger.info("Using Google credentials from environment variables");

      authClient = new GoogleAuth({
        credentials: {
          type: "service_account",
          project_id: process.env.GOOGLE_CLOUD_PROJECT,
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
        },
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });

      if (requireAuth) {
        const client = await authClient.getClient();
        await client.getAccessToken();
      }

      return authClient;
    }

    // 2️⃣ Application Default Credentials (Cloud Run, GKE, local ADC)
    logger.info("Using Application Default Credentials");

    authClient = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    if (requireAuth) {
      const client = await authClient.getClient();
      await client.getAccessToken();
    }

    return authClient;
  } catch (error) {
    logger.error(
      `Auth error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (requireAuth) {
      throw error;
    }
    return null;
  }
}

/**
 * Gets the project ID from the state manager, environment variables, or from the authenticated client
 *
 * @param requireAuth If true, will throw an error if project ID can't be determined. If false, will return a default value.
 * @returns Promise resolving to the Google Cloud project ID or a default value if not available
 */
export async function getProjectId(requireAuth = true): Promise<string> {
  try {
    // First check the state manager (fastest and most reliable method)
    const stateProjectId = stateManager.getCurrentProjectId();
    if (stateProjectId) {
      logger.debug(`Using project ID from state manager: ${stateProjectId}`);
      return stateProjectId;
    }

    // Next check environment variable
    if (process.env.GOOGLE_CLOUD_PROJECT) {
      logger.debug(
        `Using project ID from environment: ${process.env.GOOGLE_CLOUD_PROJECT}`,
      );
      // Store in state manager for future use
      await stateManager.setCurrentProjectId(process.env.GOOGLE_CLOUD_PROJECT);
      return process.env.GOOGLE_CLOUD_PROJECT;
    }

    // Check if we have credentials file and try to extract project ID from it
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      try {
        const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        logger.debug(
          `Attempting to read project ID from credentials file: ${credentialsPath}`,
        );

        if (fs.existsSync(credentialsPath)) {
          const credentialsContent = fs.readFileSync(credentialsPath, "utf8");
          const credentials = JSON.parse(credentialsContent);

          if (credentials.project_id) {
            logger.debug(
              `Found project ID in credentials file: ${credentials.project_id}`,
            );
            // Store in state manager for future use
            await stateManager.setCurrentProjectId(credentials.project_id);
            return credentials.project_id;
          }
        }
      } catch (fileError) {
        logger.warn(
          `Error reading credentials file: ${fileError instanceof Error ? fileError.message : String(fileError)}`,
        );
        // Continue to next method
      }
    }

    // Next check if we have a configured default project ID
    try {
      await configManager.initialize();
      const configuredProjectId = configManager.getDefaultProjectId();
      if (configuredProjectId) {
        logger.debug(`Using project ID from config: ${configuredProjectId}`);
        // Store in state manager for future use
        await stateManager.setCurrentProjectId(configuredProjectId);
        return configuredProjectId;
      }
    } catch (configError) {
      logger.warn(
        `Config error: ${configError instanceof Error ? configError.message : String(configError)}`,
      );
      // Continue to next method
    }

    // Fall back to getting it from auth client
    try {
      logger.debug("Attempting to get project ID from auth client...");
      const auth = await initGoogleAuth(requireAuth);
      if (!auth) {
        logger.warn("Authentication client not available");
        if (requireAuth) {
          throw new Error(
            "Google Cloud authentication not available. Please configure authentication to access project ID.",
          );
        }
        return "unknown-project";
      }

      logger.debug("Auth client available, requesting project ID...");
      const projectId = await auth.getProjectId();

      if (!projectId) {
        logger.warn("Auth client returned empty project ID");
        if (requireAuth) {
          throw new Error(
            "Could not determine Google Cloud project ID. Please set GOOGLE_CLOUD_PROJECT environment variable or use the set-project-id tool.",
          );
        }
        return "unknown-project";
      }

      logger.debug(`Got project ID from auth client: ${projectId}`);

      // Store in state manager for future use
      await stateManager.setCurrentProjectId(projectId);

      return projectId;
    } catch (authError) {
      logger.warn(
        `Auth error while getting project ID: ${authError instanceof Error ? authError.message : String(authError)}`,
      );
      if (requireAuth) {
        throw authError;
      }
      return "unknown-project";
    }
  } catch (error) {
    logger.error(
      `Project ID error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (requireAuth) {
      throw error;
    }
    return "unknown-project";
  }
}

/**
 * Sets the default project ID to use for all Google Cloud operations
 *
 * @param projectId The project ID to set as default
 */
export async function setProjectId(projectId: string): Promise<void> {
  // Use the state manager to set the project ID
  await stateManager.setCurrentProjectId(projectId);
}

/**
 * Gets the list of recently used project IDs
 *
 * @returns Array of recent project IDs
 */
export async function getRecentProjectIds(): Promise<string[]> {
  await configManager.initialize();
  return configManager.getRecentProjectIds();
}
