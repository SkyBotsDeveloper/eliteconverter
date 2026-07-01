import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  PublicApiError,
  conversionRequestSchema,
  publicConversionRequestSchema,
  randomId,
  responsibleUseNotice,
  type StatusResponse,
} from "@eliteconverter/shared";
import { authenticateApiKey } from "./auth";
import { getConfig } from "./config";
import { ok, fail, parseJson, securityHeaders } from "./http";
import {
  cancelStoredJob,
  createConversionJob,
  getCapabilities,
  getAuthorizedJob,
  getDownloadForJob,
  handleProviderWebhook,
  processQueuePayload,
  reconcileJobs,
  refreshDownload,
  toPublicJob,
} from "./jobs";
import { logError, logInfo } from "./logging";
import { enforceRateLimit } from "./rate-limit";
import { getRepository } from "./repository";
import { validateTurnstile } from "./turnstile";
import type { Env, QueuePayload, RequestContext } from "./types";

type HonoVariables = {
  requestId: string;
  context: RequestContext;
};

export const createApp = () => {
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    const requestId = c.req.header("x-request-id") ?? randomId("req", 20);
    const config = getConfig(c.env);
    const context: RequestContext = {
      requestId,
      env: c.env,
      config,
      repository: getRepository(c.env),
      fetcher: c.env.TEST_FETCH ?? fetch,
    };
    c.set("requestId", requestId);
    c.set("context", context);
    await next();
    for (const [key, value] of Object.entries(securityHeaders(config.appEnv))) {
      c.header(key, value);
    }
    c.header("X-Request-Id", requestId);
    logInfo({
      requestId,
      method: c.req.method,
      route: c.req.path,
      statusCode: c.res.status,
      durationMs: Date.now() - started,
    });
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin, c) => {
        const context = c.get("context");
        if (!origin) return "";
        return context.config.corsAllowedOrigins.includes(origin) ? origin : "";
      },
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-Request-Id",
        "EliteConverter-Signature",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: false,
      maxAge: 600,
    }),
  );

  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? randomId("req", 20);
    logError({
      requestId,
      route: c.req.path,
      method: c.req.method,
      errorCode: error instanceof PublicApiError ? error.publicError.code : "internal_error",
      message: error.message,
    });
    return fail(error, requestId);
  });

  const api = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

  api.get("/health", (c) =>
    ok(
      {
        service: "EliteConverter API",
        status: "ok",
        timestamp: new Date().toISOString(),
        responsibleUseNotice,
      },
      c.get("requestId"),
    ),
  );

  api.get("/capabilities", async (c) =>
    ok(await getCapabilities(c.get("context")), c.get("requestId")),
  );

  api.post("/conversions", async (c) => {
    const context = c.get("context");
    const principal = await authenticateApiKey(c.req.raw, context);
    await enforceRateLimit(principal.scope, context);
    const body = await parseJson<unknown>(c.req.raw);
    const input = conversionRequestSchema.parse(body);
    const result = await createConversionJob(
      input,
      principal,
      context,
      c.req.header("Idempotency-Key") ?? undefined,
    );
    return ok(
      {
        jobId: result.job.publicId,
        status: result.job.status,
        statusUrl: `/api/v1/conversions/${result.job.publicId}`,
        existing: result.existing,
      },
      c.get("requestId"),
      { status: 202 },
    );
  });

  api.post("/public/conversions", async (c) => {
    const context = c.get("context");
    const body = publicConversionRequestSchema.parse(await parseJson<unknown>(c.req.raw));
    const sessionId = c.req.header("x-anonymous-session") ?? randomId("anon", 16);
    await enforceRateLimit(
      `anon:${sessionId}`,
      context,
      context.config.maxAnonymousJobsPerDay,
      86_400_000,
    );
    await validateTurnstile(
      body.turnstileToken,
      c.req.header("cf-connecting-ip") ?? undefined,
      context,
    );
    const result = await createConversionJob(body, undefined, context, undefined, sessionId);
    return ok(
      {
        jobId: result.job.publicId,
        status: result.job.status,
        statusUrl: `/api/v1/conversions/${result.job.publicId}`,
        accessToken: result.accessToken,
      },
      c.get("requestId"),
      { status: 202 },
    );
  });

  api.get("/conversions/:jobId", async (c) => {
    const job = await getAuthorizedJob(c.req.raw, c.req.param("jobId"), c.get("context"));
    return ok(toPublicJob(job), c.get("requestId"));
  });

  api.get("/conversions/:jobId/events", async (c) => {
    const context = c.get("context");
    const job = await getAuthorizedJob(c.req.raw, c.req.param("jobId"), context);
    const events = await context.repository.listJobEvents(job.id);
    return ok({ events }, c.get("requestId"));
  });

  api.post("/conversions/:jobId/cancel", async (c) => {
    const context = c.get("context");
    const authorized = await getAuthorizedJob(c.req.raw, c.req.param("jobId"), context);
    const job = await cancelStoredJob(authorized, context);
    return ok(toPublicJob(job), c.get("requestId"));
  });

  api.post("/conversions/:jobId/refresh-download", async (c) => {
    const context = c.get("context");
    const authorized = await getAuthorizedJob(c.req.raw, c.req.param("jobId"), context);
    const job = await refreshDownload(authorized, context);
    return ok(toPublicJob(job), c.get("requestId"));
  });

  api.get("/conversions/:jobId/download", async (c) => {
    const context = c.get("context");
    const job = await getAuthorizedJob(c.req.raw, c.req.param("jobId"), context);
    return ok(getDownloadForJob(job), c.get("requestId"));
  });

  api.post("/webhooks/providers/:provider", async (c) => {
    const job = await handleProviderWebhook(c.req.param("provider"), c.req.raw, c.get("context"));
    return ok(
      { accepted: Boolean(job), job: job ? toPublicJob(job) : undefined },
      c.get("requestId"),
    );
  });

  api.post("/webhooks/test", async (c) => {
    const context = c.get("context");
    if (context.config.appEnv === "production") throw new PublicApiError("not_found", 404);
    const body = await parseJson<unknown>(c.req.raw);
    return ok(
      { received: true, echo: body, timestamp: new Date().toISOString() },
      context.requestId,
    );
  });

  api.get("/status", async (c) => {
    const context = c.get("context");
    const incidents = await context.repository.listIncidents();
    const status: StatusResponse = {
      api: "operational",
      database: context.env.DB || context.env.TEST_REPOSITORY ? "operational" : "degraded",
      queue: context.env.CONVERSION_QUEUE ? "operational" : "degraded",
      conversionSystem: "operational",
      providerNetwork: "operational",
      incidents: incidents.map((incident) => ({
        id: incident.id,
        title: incident.title,
        status: incident.status,
        severity: incident.severity,
        message: incident.message,
        updatedAt: incident.updatedAt,
      })),
    };
    return ok(status, c.get("requestId"));
  });

  app.route("/api/v1", api);

  app.get("*", async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return new Response("EliteConverter API", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });

  return app;
};

export const app = createApp();

export const handleQueueBatch = async (
  batch: MessageBatch<QueuePayload>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> => {
  const config = getConfig(env);
  const repository = getRepository(env);
  for (const message of batch.messages) {
    const context: RequestContext = {
      requestId: message.body.requestId,
      env,
      config,
      repository,
      fetcher: env.TEST_FETCH ?? fetch,
    };
    try {
      await processQueuePayload(message.body, context);
      await repository.completeScheduledTask(message.body.dedupeKey);
      message.ack();
    } catch (error) {
      const publicError = error instanceof PublicApiError ? error.publicError : undefined;
      if (publicError?.retryable) {
        message.retry();
      } else {
        logError({
          requestId: message.body.requestId,
          jobId: message.body.jobId,
          errorCode: publicError?.code ?? "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
        await repository.completeScheduledTask(message.body.dedupeKey);
        message.ack();
      }
    }
  }
};

export const handleScheduled = async (
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  const config = getConfig(env);
  const context: RequestContext = {
    requestId: randomId("req", 20),
    env,
    config,
    repository: getRepository(env),
    fetcher: env.TEST_FETCH ?? fetch,
  };
  ctx.waitUntil(
    reconcileJobs(context).then((result) => logInfo({ message: JSON.stringify(result) })),
  );
};
