import { app, handleQueueBatch, handleScheduled } from "./app";
import type { Env, QueuePayload } from "./types";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  queue(batch: MessageBatch<QueuePayload>, env: Env, ctx: ExecutionContext) {
    return handleQueueBatch(batch, env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    return handleScheduled(controller, env, ctx);
  },
};
