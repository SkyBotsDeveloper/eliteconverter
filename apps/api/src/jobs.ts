import {
  PublicApiError,
  calculateBackoffMs,
  clientWebhookHeaders,
  conversionRequestSchema,
  fingerprintRequest,
  hashApiKey,
  isRetryableError,
  nextCircuitState,
  publicErrorCatalog,
  randomId,
  randomToken,
  redactUrl,
  responsibleUseNotice,
  sanitizeDiagnostic,
  signWebhookPayload,
  timingSafeEqual,
  toPublicError,
  validateExternalUrl,
  validateRedirectChain,
  type CapabilitiesResponse,
  type ConversionRequest,
  type JobEvent,
  type OutputFormat,
  type ProviderCapabilities,
  type ProviderDownloadResult,
  type PublicJob,
  type QualityOption,
} from "@eliteconverter/shared";
import { authenticateApiKey } from "./auth";
import { getProviders } from "./providers";
import type {
  ClientWebhookEvent,
  QueuePayload,
  RequestContext,
  ScheduledTask,
  StoredJob,
  StoredProviderAttempt,
} from "./types";
import type { AuthenticatedPrincipal } from "./auth";

export interface CreateConversionResult {
  job: StoredJob;
  accessToken?: string;
  existing: boolean;
}

const terminalStatuses = new Set<StoredJob["status"]>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const retryableWebhookStatuses = new Set([408, 425, 429]);

export const getCapabilities = async (context: RequestContext): Promise<CapabilitiesResponse> => {
  const providers = getProviders(context.config);
  const providerDetails = await Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      capabilities: await provider.getCapabilities(),
    })),
  );
  const formats = intersectCapabilities(
    providerDetails.map((provider) => provider.capabilities.formats),
  );
  const qualities = intersectCapabilities(
    providerDetails.map((provider) => provider.capabilities.qualities),
  );

  return {
    product: "EliteConverter",
    tagline: "Convert Streams. Deliver Anywhere.",
    formats,
    qualities,
    providers: providerDetails,
    responsibleUseNotice,
  };
};

export const createConversionJob = async (
  input: ConversionRequest,
  principal: AuthenticatedPrincipal | undefined,
  context: RequestContext,
  idempotencyKey?: string,
  anonymousSessionId?: string,
): Promise<CreateConversionResult> => {
  const parsed = conversionRequestSchema.parse(input);
  const capabilities = await getCapabilities(context);
  assertSupportedRequest(parsed, capabilities);

  const source = validateExternalUrl(parsed.url);
  const callback = parsed.callbackUrl
    ? validateCallbackUrl(parsed.callbackUrl, context)
    : undefined;
  const ownerScope = principal
    ? `api:${principal.apiKey.id}`
    : `anon:${anonymousSessionId ?? "anonymous"}`;

  const activeCount = await context.repository.countActiveJobsForScope(ownerScope);
  const max = principal
    ? context.config.maxConcurrentJobsPerUser
    : context.config.maxAnonymousJobsPerDay;
  if (activeCount >= max) {
    throw new PublicApiError("rate_limited", 429, "Concurrent job limit reached");
  }

  const fingerprint = await fingerprintRequest(ownerScope, parsed);
  const accessToken = principal ? undefined : `ec_access_${randomToken(48)}`;
  const now = new Date();
  const job: StoredJob = {
    id: randomId("job", 24),
    publicId: randomId("ec_job", 20),
    ownerId: principal?.apiKey.ownerId,
    anonymousSessionId,
    apiKeyId: principal?.apiKey.id,
    inputUrl: source.url,
    inputUrlRedacted: source.redactedUrl,
    sourceHostname: source.hostname,
    format: parsed.format,
    quality: parsed.quality,
    status: "queued",
    progress: 0,
    currentStage: "queued",
    retryCount: 0,
    providerAttemptCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + context.config.jobExpirationHours * 60 * 60 * 1000,
    ).toISOString(),
    accessTokenHash: accessToken
      ? await hashApiKey(accessToken, context.config.apiKeyHashSecret)
      : undefined,
    idempotencyKey,
    requestFingerprint: fingerprint,
    callbackUrl: callback?.url,
    callbackUrlPrivate: callback?.url,
    callbackUrlRedacted: callback?.redactedUrl,
    pollAttemptCount: 0,
  };

  const created = await context.repository.createJobWithIdempotency({
    job,
    scope: ownerScope,
    idempotencyKey,
    fingerprint,
  });

  if (created.existing) {
    if (created.job.requestFingerprint !== fingerprint) {
      throw new PublicApiError("idempotency_conflict", 409);
    }
    return { job: created.job, existing: true };
  }

  await addEvent(context, job, "conversion.queued", "Conversion job queued.");
  await enqueueStage(context, {
    kind: "submit_provider_job",
    jobId: job.id,
    requestId: context.requestId,
    dedupeKey: `${job.id}:submit_provider_job:0`,
  });

  return {
    job: (await context.repository.getJobById(job.id)) ?? job,
    accessToken,
    existing: false,
  };
};

export const processQueuePayload = async (
  payload: QueuePayload,
  context: RequestContext,
): Promise<void> => {
  if (await context.repository.hasProcessedQueueDelivery(payload.dedupeKey)) return;

  switch (payload.kind) {
    case "submit_provider_job":
      await submitProviderJob(payload.jobId, context);
      break;
    case "poll_provider_job":
      await pollProviderJob(payload.jobId, context);
      break;
    case "refresh_provider_job":
      await refreshDownloadByInternalId(payload.jobId, context);
      break;
    case "deliver_client_webhook":
      if (!payload.webhookEventId) throw new PublicApiError("validation_error", 400);
      await processClientWebhookDelivery(payload.webhookEventId, context);
      break;
    case "reconcile_stuck_job":
      await reconcileOneJob(payload.jobId, context);
      break;
  }

  await context.repository.markQueueDeliveryProcessed(payload.dedupeKey);
};

export const submitProviderJob = async (jobId: string, context: RequestContext): Promise<void> => {
  const job = await context.repository.getJobById(jobId);
  if (!job || terminalStatuses.has(job.status)) return;
  if (new Date(job.expiresAt) <= new Date()) {
    await expireJob(context, job);
    return;
  }
  if (job.providerJobId && job.providerId) {
    await schedulePoll(context, job, 0);
    return;
  }

  const providers = getProviders(context.config);
  let lastError: unknown;

  for (const provider of providers.slice(0, context.config.maxProviderAttempts)) {
    const capabilities = await provider.getCapabilities();
    if (!providerSupportsJob(capabilities, job)) continue;
    const health = await probeHealth(context, provider.id);
    if (health.state === "open") continue;

    const attempt = startAttempt(job, provider.id);
    try {
      await context.repository.addProviderAttempt(attempt);
      const submitted = await provider.createJob(
        {
          jobId: job.id,
          idempotencyKey: job.idempotencyKey,
          sourceUrl: job.inputUrl,
          format: job.format,
          quality: job.quality,
          callbackUrl: job.callbackUrlPrivate,
        },
        {
          requestId: context.requestId,
          deadlineMs: Date.now() + context.config.genericProvider.timeoutMs,
          fetcher: context.fetcher,
        },
      );
      const updated = {
        ...job,
        status: submitted.status === "retrying" ? "retrying" : "processing",
        providerId: provider.id,
        providerJobId: submitted.providerJobId,
        providerAttemptCount: job.providerAttemptCount + 1,
        progress: submitted.status === "retrying" ? 35 : 25,
        currentStage: submitted.status,
      } satisfies StoredJob;
      await updateJob(context, updated);
      await context.repository.addProviderAttempt({
        ...attempt,
        status: "submitted",
        providerJobId: submitted.providerJobId,
        finishedAt: new Date().toISOString(),
      });
      await addEvent(context, updated, "conversion.processing", "Provider accepted the job.");
      await context.repository.setProviderHealth(
        nextCircuitState(health, "success", circuitOptions(context)),
      );

      if (submitted.status === "completed" && submitted.download) {
        await completeJob(context, updated, submitted.download);
      } else {
        await schedulePoll(context, updated, context.config.initialRetryDelayMs);
      }
      return;
    } catch (error) {
      lastError = error;
      const publicError = toPublicError(error);
      await context.repository.addProviderAttempt({
        ...attempt,
        status: "failed",
        errorCode: publicError.code,
        retryable: publicError.retryable,
        finishedAt: new Date().toISOString(),
      });
      await context.repository.setProviderHealth(
        nextCircuitState(health, "failure", circuitOptions(context)),
      );
      if (!isRetryableError(publicError.code)) break;
    }
  }

  await failJob(context, job, lastError);
};

export const pollProviderJob = async (jobId: string, context: RequestContext): Promise<void> => {
  const job = await context.repository.getJobById(jobId);
  if (!job || terminalStatuses.has(job.status)) return;
  if (new Date(job.expiresAt) <= new Date()) {
    await expireJob(context, job);
    return;
  }
  if (job.status === "cancel_requested") {
    await cancelStoredJob(job, context);
    return;
  }
  if (!job.providerId || !job.providerJobId) {
    await enqueueStage(context, {
      kind: "submit_provider_job",
      jobId: job.id,
      requestId: context.requestId,
      dedupeKey: `${job.id}:submit_provider_job:missing-provider`,
    });
    return;
  }

  const provider = getProviders(context.config).find(
    (candidate) => candidate.id === job.providerId,
  );
  if (!provider) throw new PublicApiError("internal_configuration_error", 500);

  try {
    const status = await provider.getJobStatus(job.providerJobId, {
      requestId: context.requestId,
      deadlineMs: Date.now() + context.config.genericProvider.timeoutMs,
      fetcher: context.fetcher,
    });

    if (status.status === "completed" && status.download) {
      await completeJob(context, job, status.download);
      await context.repository.setProviderHealth(
        nextCircuitState(await getHealth(context, provider.id), "success", circuitOptions(context)),
      );
      return;
    }

    if (status.status === "failed") {
      if (status.retryable && (job.retryCount ?? 0) < context.config.maxRetryAttempts) {
        const retrying = {
          ...job,
          status: "retrying",
          currentStage: status.stage,
          progress: status.progress,
          retryCount: job.retryCount + 1,
        } satisfies StoredJob;
        await updateJob(context, retrying);
        await schedulePoll(context, retrying);
        return;
      }
      await failJob(context, job, new PublicApiError(status.errorCode ?? "conversion_failed", 400));
      return;
    }

    const updated = {
      ...job,
      status: status.status === "retrying" ? "retrying" : "processing",
      progress: status.progress,
      currentStage: status.stage,
      pollAttemptCount: job.pollAttemptCount + 1,
    } satisfies StoredJob;
    await updateJob(context, updated);
    await schedulePoll(context, updated);
  } catch (error) {
    const publicError = toPublicError(error);
    if (isRetryableError(publicError.code) && job.retryCount < context.config.maxRetryAttempts) {
      const retrying = {
        ...job,
        status: "retrying",
        currentStage: "provider retry scheduled",
        retryCount: job.retryCount + 1,
        pollAttemptCount: job.pollAttemptCount + 1,
      } satisfies StoredJob;
      await updateJob(context, retrying);
      await schedulePoll(context, retrying);
      return;
    }
    await failJob(context, job, error);
  }
};

export const cancelStoredJob = async (
  job: StoredJob,
  context: RequestContext,
): Promise<StoredJob> => {
  if (terminalStatuses.has(job.status)) return job;
  if (job.providerId && job.providerJobId) {
    const provider = getProviders(context.config).find(
      (candidate) => candidate.id === job.providerId,
    );
    await provider?.cancelJob?.(job.providerJobId, {
      requestId: context.requestId,
      deadlineMs: Date.now() + 10000,
      fetcher: context.fetcher,
    });
  }
  const cancelled = {
    ...job,
    status: "cancelled",
    progress: 100,
    currentStage: "cancelled",
    cancellationState: "confirmed",
    nextPollAt: undefined,
  } satisfies StoredJob;
  await updateJob(context, cancelled);
  await addEvent(context, cancelled, "conversion.cancelled", "Conversion job cancelled.");
  await queueClientWebhook(context, cancelled, "conversion.cancelled");
  return cancelled;
};

export const refreshDownload = async (
  job: StoredJob,
  context: RequestContext,
): Promise<StoredJob> => refreshDownloadByInternalId(job.id, context);

export const refreshDownloadByInternalId = async (
  jobId: string,
  context: RequestContext,
): Promise<StoredJob> => {
  const job = await context.repository.getJobById(jobId);
  if (!job) throw new PublicApiError("not_found", 404);
  if (job.status !== "completed" || !job.providerId || !job.providerJobId) {
    throw new PublicApiError("output_unavailable", 400);
  }
  const provider = getProviders(context.config).find(
    (candidate) => candidate.id === job.providerId,
  );
  if (!provider?.refreshDownloadUrl) throw new PublicApiError("output_expired", 400);
  const download = await provider.refreshDownloadUrl(job.providerJobId, {
    requestId: context.requestId,
    deadlineMs: Date.now() + 10000,
    fetcher: context.fetcher,
  });
  await validateProviderDownload(download, context);
  const updated = {
    ...job,
    outputUrl: redactUrl(download.url),
    outputUrlPrivate: download.url,
    outputUrlRedacted: redactUrl(download.url),
    outputUrlExpiresAt: download.expiresAt,
    outputMimeType: download.mimeType,
    outputFileSize: download.fileSize,
  } satisfies StoredJob;
  await updateJob(context, updated);
  return updated;
};

export const getDownloadForJob = (job: StoredJob): { url: string; expiresAt?: string } => {
  if (job.status !== "completed" || !job.outputUrlPrivate) {
    throw new PublicApiError("output_unavailable", 404);
  }
  return { url: job.outputUrlPrivate, expiresAt: job.outputUrlExpiresAt };
};

export const handleProviderWebhook = async (
  providerId: string,
  request: Request,
  context: RequestContext,
): Promise<StoredJob | undefined> => {
  const provider = getProviders(context.config).find((candidate) => candidate.id === providerId);
  if (!provider?.verifyWebhook) throw new PublicApiError("not_found", 404);
  const event = await provider.verifyWebhook(request.clone() as unknown as Request);
  const accepted = await context.repository.recordProviderWebhookEvent({
    id: randomId("pwe", 20),
    providerId,
    providerEventId: event.providerEventId,
    providerJobId: event.providerJobId,
    eventType: event.status,
    receivedAt: new Date().toISOString(),
  });
  if (!accepted) return undefined;

  const activeJobs = await context.repository.listActiveJobs();
  const job = activeJobs.find((candidate) => candidate.providerJobId === event.providerJobId);
  if (!job || terminalStatuses.has(job.status)) return job;
  if (event.status === "completed" && event.download) {
    return completeJob(context, job, event.download);
  }
  if (event.status === "failed") {
    await failJob(context, job, new PublicApiError("conversion_failed", 400));
    return (await context.repository.getJobById(job.id)) ?? job;
  }
  const updated = {
    ...job,
    status: event.status === "retrying" ? "retrying" : "processing",
    progress: event.progress ?? job.progress,
    currentStage: event.status,
  } satisfies StoredJob;
  await updateJob(context, updated);
  return updated;
};

export const reconcileJobs = async (
  context: RequestContext,
): Promise<{ processed: number; expired: number; webhooks: number }> => {
  const now = new Date().toISOString();
  let processed = 0;
  let expired = 0;
  let webhooks = 0;

  const dueTasks = await context.repository.claimDueScheduledTasks(now, 50);
  for (const task of dueTasks) {
    try {
      await processQueuePayload(task.payload, context);
      await context.repository.completeScheduledTask(task.dedupeKey);
      processed += 1;
    } catch (error) {
      await context.repository.failScheduledTask(task.dedupeKey, sanitizeDiagnostic(error));
      const publicError = toPublicError(error);
      if (!publicError.retryable) processed += 1;
    }
  }

  const activeJobs = await context.repository.listActiveJobs();
  for (const job of activeJobs) {
    if (new Date(job.expiresAt) <= new Date()) {
      await expireJob(context, job);
      expired += 1;
      continue;
    }
    if (job.nextPollAt && job.nextPollAt <= now) {
      await enqueueStage(context, {
        kind: "poll_provider_job",
        jobId: job.id,
        requestId: context.requestId,
        dedupeKey: `${job.id}:poll_provider_job:${job.pollAttemptCount}`,
      });
      processed += 1;
    }
  }

  const dueWebhookEvents = await context.repository.listDueClientWebhookEvents(now, 50);
  for (const event of dueWebhookEvents) {
    await enqueueStage(context, {
      kind: "deliver_client_webhook",
      jobId: event.jobId,
      requestId: context.requestId,
      dedupeKey: `${event.jobId}:deliver_client_webhook:${event.eventId}:${event.attemptCount}`,
      webhookEventId: event.eventId,
    });
    webhooks += 1;
  }

  return { processed, expired, webhooks };
};

export const getAuthorizedJob = async (
  request: Request,
  publicId: string,
  context: RequestContext,
): Promise<StoredJob> => {
  const job = await getExistingJob(publicId, context);
  await assertJobAccess(request, job, context);
  return job;
};

export const toPublicJob = (job: StoredJob, includeDownloadUrl = false): PublicJob => ({
  jobId: job.publicId,
  status: job.status,
  progress: job.progress,
  currentStage: job.currentStage,
  format: job.format,
  quality: job.quality,
  inputUrlRedacted: job.inputUrlRedacted,
  sourceHostname: job.sourceHostname,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  expiresAt: job.expiresAt,
  completedAt: job.completedAt,
  outputUrl: includeDownloadUrl ? job.outputUrlPrivate : undefined,
  outputUrlExpiresAt: job.outputUrlExpiresAt,
  outputMimeType: job.outputMimeType,
  outputFileSize: job.outputFileSize,
  error: job.publicErrorCode
    ? {
        code: job.publicErrorCode,
        message: job.publicErrorMessage ?? publicErrorCatalog[job.publicErrorCode].message,
        retryable: publicErrorCatalog[job.publicErrorCode].retryable,
      }
    : undefined,
});

export const getExistingJob = async (
  publicId: string,
  context: RequestContext,
): Promise<StoredJob> => {
  const job = await context.repository.getJobByPublicId(publicId);
  if (!job) throw new PublicApiError("not_found", 404);
  return job;
};

const schedulePoll = async (
  context: RequestContext,
  job: StoredJob,
  explicitDelayMs?: number,
): Promise<void> => {
  const delayMs =
    explicitDelayMs ??
    calculateBackoffMs(
      Math.max(1, job.pollAttemptCount + 1),
      {
        initialDelayMs: context.config.initialRetryDelayMs,
        maxDelayMs: context.config.maxRetryDelayMs,
        maxAttempts: context.config.maxRetryAttempts,
        jitterRatio: 0.1,
      },
      () => 0,
    );
  const nextPollAt = new Date(Date.now() + delayMs).toISOString();
  await updateJob(context, { ...job, nextPollAt });
  await enqueueStage(
    context,
    {
      kind: "poll_provider_job",
      jobId: job.id,
      requestId: context.requestId,
      dedupeKey: `${job.id}:poll_provider_job:${job.pollAttemptCount + 1}`,
    },
    nextPollAt,
  );
};

const enqueueStage = async (
  context: RequestContext,
  payload: QueuePayload,
  runAt = new Date().toISOString(),
): Promise<void> => {
  const task: ScheduledTask = {
    id: randomId("task", 20),
    kind: payload.kind,
    jobId: payload.jobId,
    payload,
    runAt,
    status: "pending",
    attempts: 0,
    dedupeKey: payload.dedupeKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await context.repository.scheduleTask(task);

  if (context.env.CONVERSION_QUEUE) {
    const delaySeconds = Math.max(0, Math.ceil((new Date(runAt).getTime() - Date.now()) / 1000));
    if (delaySeconds <= 43_200) {
      if (delaySeconds > 0) {
        await context.env.CONVERSION_QUEUE.send(payload, { delaySeconds });
      } else {
        await context.env.CONVERSION_QUEUE.send(payload);
      }
    }
    return;
  }

  if (runAt <= new Date().toISOString()) {
    await processQueuePayload(payload, context);
    await context.repository.completeScheduledTask(payload.dedupeKey);
  }
};

const queueClientWebhook = async (
  context: RequestContext,
  job: StoredJob,
  eventType: string,
): Promise<void> => {
  if (!job.callbackUrlPrivate) return;
  const eventId = randomId("evt", 20);
  const event: ClientWebhookEvent = {
    id: randomId("cwe", 20),
    jobId: job.id,
    eventId,
    eventType,
    payloadJson: JSON.stringify({
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data: toPublicJob(job, false),
    }),
    callbackUrlPrivate: job.callbackUrlPrivate,
    callbackUrlRedacted: job.callbackUrlRedacted ?? redactUrl(job.callbackUrlPrivate),
    status: "pending",
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await context.repository.createClientWebhookEvent(event);
  await enqueueStage(context, {
    kind: "deliver_client_webhook",
    jobId: job.id,
    requestId: context.requestId,
    dedupeKey: `${job.id}:deliver_client_webhook:${event.eventId}:0`,
    webhookEventId: event.eventId,
  });
};

const processClientWebhookDelivery = async (
  eventId: string,
  context: RequestContext,
): Promise<void> => {
  const event = await context.repository.getClientWebhookEvent(eventId);
  if (!event || event.status === "delivered" || event.status === "permanently_failed") return;
  if (event.status === "delivering") return;

  const delivering = {
    ...event,
    status: "delivering" as const,
    attemptCount: event.attemptCount + 1,
    updatedAt: new Date().toISOString(),
  };
  await context.repository.updateClientWebhookEvent(delivering);

  let statusCode: number | undefined;
  let nextStatus: ClientWebhookEvent["status"] = "delivered";
  let lastError: string | undefined;
  try {
    const signed = await signWebhookPayload(
      context.config.clientWebhookSigningSecret,
      event.payloadJson,
      Math.floor(Date.now() / 1000).toString(),
      event.eventId,
    );
    const response = await context.fetcher(event.callbackUrlPrivate, {
      method: "POST",
      headers: clientWebhookHeaders(signed),
      body: event.payloadJson,
    });
    statusCode = response.status;
    if (!response.ok) {
      nextStatus = shouldRetryWebhookStatus(response.status, delivering.attemptCount, context)
        ? "retrying"
        : "permanently_failed";
      lastError = `HTTP ${response.status}`;
    }
  } catch (error) {
    nextStatus =
      delivering.attemptCount < context.config.clientWebhookMaxAttempts
        ? "retrying"
        : "permanently_failed";
    lastError = sanitizeDiagnostic(error);
  }

  const nextAttemptAt =
    nextStatus === "retrying"
      ? new Date(
          Date.now() +
            calculateBackoffMs(
              delivering.attemptCount,
              {
                initialDelayMs: context.config.initialRetryDelayMs,
                maxDelayMs: context.config.maxRetryDelayMs,
                maxAttempts: context.config.clientWebhookMaxAttempts,
                jitterRatio: 0.2,
              },
              () => 0,
            ),
        ).toISOString()
      : undefined;

  const updated: ClientWebhookEvent = {
    ...delivering,
    status: nextStatus,
    lastStatusCode: statusCode,
    lastError,
    nextAttemptAt,
    updatedAt: new Date().toISOString(),
  };
  await context.repository.updateClientWebhookEvent(updated);
  await context.repository.recordClientWebhookDelivery({
    id: randomId("cwd", 20),
    jobId: event.jobId,
    eventId: event.eventId,
    eventType: event.eventType,
    callbackUrlRedacted: event.callbackUrlRedacted,
    status: nextStatus,
    attemptCount: updated.attemptCount,
    lastStatusCode: statusCode,
    nextAttemptAt,
    createdAt: event.createdAt,
    updatedAt: updated.updatedAt,
  });

  if (nextStatus === "retrying" && nextAttemptAt) {
    await enqueueStage(
      context,
      {
        kind: "deliver_client_webhook",
        jobId: event.jobId,
        requestId: context.requestId,
        dedupeKey: `${event.jobId}:deliver_client_webhook:${event.eventId}:${updated.attemptCount}`,
        webhookEventId: event.eventId,
      },
      nextAttemptAt,
    );
  }
};

const completeJob = async (
  context: RequestContext,
  job: StoredJob,
  download: ProviderDownloadResult,
): Promise<StoredJob> => {
  await validateProviderDownload(download, context);
  const completed = {
    ...job,
    status: "completed",
    progress: 100,
    currentStage: "completed",
    completedAt: new Date().toISOString(),
    nextPollAt: undefined,
    outputUrl: redactUrl(download.url),
    outputUrlPrivate: download.url,
    outputUrlRedacted: redactUrl(download.url),
    outputUrlExpiresAt: download.expiresAt,
    outputMimeType: download.mimeType,
    outputFileSize: download.fileSize,
  } satisfies StoredJob;
  await updateJob(context, completed);
  await addEvent(context, completed, "conversion.completed", "Conversion completed.");
  await queueClientWebhook(context, completed, "conversion.completed");
  return completed;
};

const validateProviderDownload = async (
  download: ProviderDownloadResult,
  context: RequestContext,
): Promise<void> => {
  validateExternalUrl(download.url, "output_unavailable");
  await validateRedirectChain(download.url, {
    fetcher: context.fetcher,
    maxRedirects: 3,
    expectedContentTypes: download.mimeType ? [download.mimeType] : undefined,
  });
};

const failJob = async (context: RequestContext, job: StoredJob, error: unknown): Promise<void> => {
  const publicError = toPublicError(error);
  const failed = {
    ...job,
    status: "failed",
    progress: 100,
    currentStage: "failed",
    nextPollAt: undefined,
    publicErrorCode: publicError.code,
    publicErrorMessage: publicError.message,
    internalDiagnostic: sanitizeDiagnostic(error),
  } satisfies StoredJob;
  await updateJob(context, failed);
  await addEvent(context, failed, "conversion.failed", publicError.message);
  await queueClientWebhook(context, failed, "conversion.failed");
};

const expireJob = async (context: RequestContext, job: StoredJob): Promise<void> => {
  const expiredJob = {
    ...job,
    status: "expired",
    progress: 100,
    currentStage: "expired",
    nextPollAt: undefined,
    publicErrorCode: "source_expired",
    publicErrorMessage: publicErrorCatalog.source_expired.message,
  } satisfies StoredJob;
  await updateJob(context, expiredJob);
  await addEvent(context, expiredJob, "conversion.expired", "Conversion job expired.");
  await queueClientWebhook(context, expiredJob, "conversion.expired");
};

const reconcileOneJob = async (jobId: string, context: RequestContext): Promise<void> => {
  const job = await context.repository.getJobById(jobId);
  if (!job || terminalStatuses.has(job.status)) return;
  if (new Date(job.expiresAt) <= new Date()) await expireJob(context, job);
  else if (job.providerJobId) await pollProviderJob(job.id, context);
  else await submitProviderJob(job.id, context);
};

const updateJob = async (context: RequestContext, job: StoredJob): Promise<void> => {
  await context.repository.updateJob({ ...job, updatedAt: new Date().toISOString() });
};

const addEvent = async (
  context: RequestContext,
  job: StoredJob,
  type: string,
  message: string,
  safeDetails?: string,
): Promise<JobEvent> => {
  const event: JobEvent = {
    id: randomId("evt", 20),
    jobId: job.id,
    type,
    message,
    safeDetails,
    createdAt: new Date().toISOString(),
  };
  await context.repository.addJobEvent(event);
  return event;
};

const startAttempt = (job: StoredJob, providerId: string): StoredProviderAttempt => ({
  id: randomId("att", 20),
  jobId: job.id,
  providerId,
  status: "started",
  attemptNumber: job.providerAttemptCount + 1,
  retryable: false,
  startedAt: new Date().toISOString(),
});

const validateCallbackUrl = (
  rawUrl: string,
  context: RequestContext,
): ReturnType<typeof validateExternalUrl> => {
  const callback = validateExternalUrl(rawUrl, "invalid_source_url");
  if (
    context.config.callbackHostAllowlist.length &&
    !context.config.callbackHostAllowlist.includes(callback.hostname)
  ) {
    throw new PublicApiError("invalid_source_url", 400, "Callback host is not allowlisted");
  }
  return callback;
};

const assertSupportedRequest = (
  input: ConversionRequest,
  capabilities: CapabilitiesResponse,
): void => {
  if (!capabilities.formats.includes(input.format)) {
    throw new PublicApiError("unsupported_format", 400);
  }
  if (!capabilities.qualities.includes(input.quality)) {
    throw new PublicApiError("unsupported_quality", 400);
  }
  const maxInputUrlLength = Math.min(
    ...capabilities.providers.map((provider) => provider.capabilities.maxInputUrlLength),
  );
  if (input.url.length > maxInputUrlLength) {
    throw new PublicApiError("invalid_source_url", 400, "Input URL exceeds provider limit");
  }
};

const providerSupportsJob = (capabilities: ProviderCapabilities, job: StoredJob): boolean =>
  capabilities.formats.includes(job.format) && capabilities.qualities.includes(job.quality);

const assertJobAccess = async (
  request: Request,
  job: StoredJob,
  context: RequestContext,
): Promise<void> => {
  if (job.apiKeyId) {
    const principal = await authenticateApiKey(request, context);
    if (principal.apiKey.id !== job.apiKeyId) {
      throw new PublicApiError("forbidden", 403, "API key does not own this job");
    }
    return;
  }

  const token = readJobAccessToken(request);
  if (!token || !job.accessTokenHash) {
    throw new PublicApiError("unauthorized", 401, "Job access token required");
  }
  const hash = await hashApiKey(token, context.config.apiKeyHashSecret);
  if (!timingSafeEqual(hash, job.accessTokenHash)) {
    throw new PublicApiError("forbidden", 403, "Invalid job access token");
  }
};

const readJobAccessToken = (request: Request): string | undefined => {
  const explicit = request.headers.get("EliteConverter-Job-Token");
  if (explicit) return explicit;
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, value] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() === "bearer" && value?.startsWith("ec_access_")) return value;
  try {
    return new URL(request.url).searchParams.get("access_token") ?? undefined;
  } catch {
    return undefined;
  }
};

const probeHealth = async (context: RequestContext, providerId: string) => {
  const health = await getHealth(context, providerId);
  const probed = nextCircuitState(health, "probe", circuitOptions(context));
  await context.repository.setProviderHealth(probed);
  return probed;
};

const getHealth = async (context: RequestContext, providerId: string) =>
  (await context.repository.getProviderHealth(providerId)) ?? {
    providerId,
    state: "closed" as const,
    consecutiveFailures: 0,
    recentSuccesses: 0,
    recentFailures: 0,
    updatedAt: new Date().toISOString(),
  };

const circuitOptions = (context: RequestContext) => ({
  threshold: context.config.circuitBreakerThreshold,
  cooldownSeconds: context.config.circuitBreakerCooldownSeconds,
});

const shouldRetryWebhookStatus = (
  status: number,
  attemptCount: number,
  context: RequestContext,
): boolean =>
  attemptCount < context.config.clientWebhookMaxAttempts &&
  (status >= 500 || retryableWebhookStatuses.has(status));

const intersectCapabilities = <T extends OutputFormat | QualityOption>(values: T[][]): T[] => {
  const [first, ...rest] = values;
  if (!first) return [];
  return first.filter((item) => rest.every((list) => list.includes(item)));
};
