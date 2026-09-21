import { Router } from "express";
import { createGameRouter } from "./game";
import { createManagementRouter } from "./management";
import { createModerationRouter } from "./moderationRoutes";
import { createPanelRouter } from "./panel";

/** Admin & moderation API. Mounted inside the LEGACY-X router so it shares CORS, rate limits and error handling. */
export function createAdminRouter() {
  const router = Router();
  router.use(createGameRouter());
  router.use(createPanelRouter());
  router.use(createModerationRouter());
  router.use(createManagementRouter());
  return router;
}
