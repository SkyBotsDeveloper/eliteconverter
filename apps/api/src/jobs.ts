import {
  PublicApiError,
  calculateBackoffMs,
  clientWebhookHeaders,
  conversionRequestSchema,
  fingerprintRequest,
  isRetryableError,
  nextCircuitState,
  publicErrorCatalog,
  randomId,
  redactUrl,
  responsibleUseNotice,
  sanitizeDiagnostic,
  signWebhookPayload,
  toPublicError,
  validateExternalUrl,
  type CapabilitiesResponse,
  type ConversionProvider,
  type ConversionRequest,
  type JobEvent,
  type PublicJob,
} from "@eliteconverter/shared";
import { getProviders } from "./providers";
import type { AuthenticatedPrincipal } from "./auth";
import type { RequestContext, StoredJob, StoredProviderAttempt } from "./types";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

export const getCapabilities = async (context: RequestContext): Promise<CapabilitiesResponse> => {
  const providers = getProviders(context.config);
  return {
    product: "EliteConverter",
    tagline: "Convert Streams. Deliver Anywhere.",
    formats: ["mp4", "webm", "mkv", "mp3", "m4a"],
    qualities: ["source", "1080p", "720p", "480p", "audio"],
    providers: await Promise.all(
      providers.map(async (provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        capabilities: await provider.getCapabilities(),
      })),
    ),
    responsibleUseNotice,
  };
};

export const createConversionJob = async (
  input: ConversionRequest,
  principal: AuthenticatedPrincipal | undefined,
  context: RequestContext,
  idempotencyKey?: string,
  anonymousSessionId?: string,
): Promise<StoredJob> => {
  const parsed = conversionRequestSchema.parse(input);
  const source = validateExternalUrl(parsed.url);
  const callback = parsed.callbackUrl
    ? validateExternalUrl(parsed.callbackUrl, "invalid_source_url")
    : undefined;
  const ownerScope = principal
    ? `api:${principal.apiKey.id}`
    : `anon:${anonymousSessionId ?? "anonymous"}`;

  const activeCount = await context.repository.countActiveJobsForScope(ownerScope);
  const max = principal
    ? context.config.maxConcurrentJobsPerUser
    : context.config.maxAnonymousJobsPerDay;
  if (activeCount >= max)
    throw new PublicApiError("rate_limited", 429, "Concurrent job limit reached");

  const fingerprint = await fingerprintRequest(ownerScope, parsed);
  if (idempotencyKey) {
    const existing = await context.repository.findJobByIdempotency(ownerScope, idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PublicApiError("idempotency_conflict", 409);
      }
      return existing;
    }
  }

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
    idempotencyKey,
    requestFingerprint: fingerprint,
    callbackUrl: callback?.url,
  };

  await context.repository.insertJob(job);
  if (idempotencyKey) {
    await context.repository.insertIdempotency(ownerScope, idempotencyKey, fingerprint, job.id);
  }
  await addEvent(context, job, "conversion.queued", "Conversion job queued.");

  await context.env.CONVERSION_QUEUE?.send({ jobId: job.id, requestId: context.requestId });
  if (!context.env.CONVERSION_QUEUE) {
    await processConversionJob(job.id, context);
  }

  return (await context.repository.getJobById(job.id)) ?? job;
};

export const processConversionJob = async (
  jobId: string,
  context: RequestContext,
): Promise<void> => {
  const job = await context.repository.getJobById(jobId);
  if (!job || terminalStatuses.has(job.status)) return;
  if (job.status === "cancel_requested") {
    await updateJob(context, {
      ...job,
      status: "cancelled",
      progress: 100,
      currentStage: "cancelled",
    });
    await addEvent(context, job, "conversion.cancelled", "Conversion job cancelled.");
    return;
  }

  const providers = getProviders(context.config);
  let lastError: unknown;

  for (const provider of providers.slice(0, context.config.maxProviderAttempts)) {
    const health = await getHealth(context, provider.id);
    const probed = nextCircuitState(health, "probe", {
      threshold: context.config.circuitBreakerThreshold,
      cooldownSeconds: context.config.circuitBreakerCooldownSeconds,
    });
    await context.repository.setProviderHealth(probed);
    if (probed.state === "open") continue;

    const attempt = startAttempt(job, provider.id);
    try {
      await context.repository.addProviderAttempt(attempt);
      const submitted = await submitToProvider(provider, job, context);
      const current = {
        ...job,
        status: submitted.status === "retrying" ? "retrying" : "processing",
        providerId: provider.id,
        providerJobId: submitted.providerJobId,
        providerAttemptCount: job.providerAttemptCount + 1,
        progress: submitted.status === "retrying" ? 35 : 50,
        currentStage: submitted.status,
      } satisfies StoredJob;
      await updateJob(context, current);
      await addEvent(context, current, "conversion.processing", "Provider accepted the job.");

      const completed = await pollProviderToTerminal(provider, current, context);
      await context.repository.setProviderHealth(
        nextCircuitState(probed, "success", {
          threshold: context.config.circuitBreakerThreshold,
          cooldownSeconds: context.config.circuitBreakerCooldownSeconds,
        }),
      );
      await context.repository.addProviderAttempt({
        ...attempt,
        status: "completed",
        providerJobId: completed.providerJobId,
        finishedAt: new Date().toISOString(),
      });
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
        nextCircuitState(probed, "failure", {
          threshold: context.config.circuitBreakerThreshold,
          cooldownSeconds: context.config.circuitBreakerCooldownSeconds,
        }),
      );
      if (!isRetryableError(publicError.code)) break;
    }
  }

  const publicError = toPublicError(lastError);
  const failed = {
    ...((await context.repository.getJobById(jobId)) ?? job),
    status: "failed",
    progress: 100,
    currentStage: "failed",
    publicErrorCode: publicError.code,
    publicErrorMessage: publicError.message,
    internalDiagnostic: sanitizeDiagnostic(lastError),
  } satisfies StoredJob;
  await updateJob(context, failed);
  await addEvent(context, failed, "conversion.failed", publicError.message);
  await deliverClientWebhook(context, failed, "conversion.failed");
};

export const cancelJob = async (publicId: string, context: RequestContext): Promise<StoredJob> => {
  const job = await getExistingJob(publicId, context);
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
  } satisfies StoredJob;
  await updateJob(context, cancelled);
  await addEvent(context, cancelled, "conversion.cancelled", "Conversion job cancelled.");
  await deliverClientWebhook(context, cancelled, "conversion.cancelled");
  return cancelled;
};

export const refreshDownload = async (
  publicId: string,
  context: RequestContext,
): Promise<StoredJob> => {
  const job = await getExistingJob(publicId, context);
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
  validateExternalUrl(download.url, "output_unavailable");
  const updated = {
    ...job,
    outputUrl: redactUrl(download.url),
    outputUrlExpiresAt: download.expiresAt,
    outputMimeType: download.mimeType,
    outputFileSize: download.fileSize,
  } satisfies StoredJob;
  await updateJob(context, updated);
  return updated;
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
  if (!job) return undefined;
  if (event.status === "completed" && event.download) {
    return completeJob(context, job, event.download);
  }
  if (event.status === "failed") {
    const failed = {
      ...job,
      status: "failed",
      progress: 100,
      currentStage: "failed",
      publicErrorCode: "conversion_failed",
      publicErrorMessage: publicErrorCatalog.conversion_failed.message,
    } satisfies StoredJob;
    await updateJob(context, failed);
    await addEvent(context, failed, "conversion.failed", "Provider reported failure.");
    await deliverClientWebhook(context, failed, "conversion.failed");
    return failed;
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
): Promise<{ processed: number; expired: number }> => {
  const before = new Date(
    Date.now() - context.config.staleJobThresholdMinutes * 60 * 1000,
  ).toISOString();
  const stuck = await context.repository.listStuckJobs(before);
  let processed = 0;
  let expired = 0;
  for (const job of stuck) {
    if (new Date(job.expiresAt) < new Date()) {
      const expiredJob = {
        ...job,
        status: "expired",
        progress: 100,
        currentStage: "expired",
        publicErrorCode: "source_expired",
        publicErrorMessage: publicErrorCatalog.source_expired.message,
      } satisfies StoredJob;
      await updateJob(context, expiredJob);
      await addEvent(context, expiredJob, "conversion.expired", "Conversion job expired.");
      await deliverClientWebhook(context, expiredJob, "conversion.expired");
      expired += 1;
    } else {
      await processConversionJob(job.id, context);
      processed += 1;
    }
  }
  return { processed, expired };
};

export const toPublicJob = (job: StoredJob): PublicJob => ({
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
  outputUrl: job.outputUrl,
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

const submitToProvider = async (
  provider: ConversionProvider,
  job: StoredJob,
  context: RequestContext,
) =>
  provider.createJob(
    {
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      sourceUrl: job.inputUrl,
      format: job.format,
      quality: job.quality,
      callbackUrl: job.callbackUrl,
    },
    {
      requestId: context.requestId,
      deadlineMs: Date.now() + context.config.genericProvider.timeoutMs,
      fetcher: context.fetcher,
    },
  );

const pollProviderToTerminal = async (
  provider: ConversionProvider,
  job: StoredJob,
  context: RequestContext,
): Promise<{ providerJobId: string }> => {
  if (!job.providerJobId) throw new PublicApiError("provider_temporary_failure", 502);
  let current = job;
  for (let attempt = 1; attempt <= context.config.maxRetryAttempts + 1; attempt += 1) {
    const status = await provider.getJobStatus(job.providerJobId, {
      requestId: context.requestId,
      deadlineMs: Date.now() + context.config.genericProvider.timeoutMs,
      fetcher: context.fetcher,
    });

    if (status.status === "completed" && status.download) {
      await completeJob(context, current, status.download);
      return { providerJobId: status.providerJobId };
    }

    if (status.status === "failed") {
      throw new PublicApiError(
        status.errorCode ?? "conversion_failed",
        status.retryable ? 503 : 400,
      );
    }

    current = {
      ...current,
      status: status.status === "retrying" ? "retrying" : "processing",
      progress: status.progress,
      currentStage: status.stage,
      retryCount: status.status === "retrying" ? current.retryCount + 1 : current.retryCount,
    };
    await updateJob(context, current);

    const delay = calculateBackoffMs(
      attempt,
      {
        initialDelayMs: context.config.initialRetryDelayMs,
        maxDelayMs: context.config.maxRetryDelayMs,
        maxAttempts: context.config.maxRetryAttempts,
        jitterRatio: 0.1,
      },
      () => 0,
    );
    if (delay > 0 && context.config.appEnv === "production") {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 1000)));
    }
  }

  throw new PublicApiError(
    "provider_temporary_failure",
    503,
    "Provider did not reach terminal state",
  );
};

const completeJob = async (
  context: RequestContext,
  job: StoredJob,
  download: { url: string; expiresAt?: string; mimeType?: string; fileSize?: number },
): Promise<StoredJob> => {
  const safeOutput = validateExternalUrl(download.url, "output_unavailable");
  const completed = {
    ...job,
    status: "completed",
    progress: 100,
    currentStage: "completed",
    completedAt: new Date().toISOString(),
    outputUrl: safeOutput.redactedUrl,
    outputUrlExpiresAt: download.expiresAt,
    outputMimeType: download.mimeType,
    outputFileSize: download.fileSize,
  } satisfies StoredJob;
  await updateJob(context, completed);
  await addEvent(context, completed, "conversion.completed", "Conversion completed.");
  await deliverClientWebhook(context, completed, "conversion.completed");
  return completed;
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

const getHealth = async (context: RequestContext, providerId: string) =>
  (await context.repository.getProviderHealth(providerId)) ?? {
    providerId,
    state: "closed" as const,
    consecutiveFailures: 0,
    recentSuccesses: 0,
    recentFailures: 0,
    updatedAt: new Date().toISOString(),
  };

const deliverClientWebhook = async (
  context: RequestContext,
  job: StoredJob,
  eventType: string,
): Promise<void> => {
  if (!job.callbackUrl) return;
  const payload = JSON.stringify({
    id: randomId("evt", 20),
    type: eventType,
    createdAt: new Date().toISOString(),
    data: toPublicJob(job),
  });
  const signed = await signWebhookPayload(context.config.clientWebhookSigningSecret, payload);
  let status: string;
  let statusCode: number | undefined;
  try {
    const response = await context.fetcher(job.callbackUrl, {
      method: "POST",
      headers: clientWebhookHeaders(signed),
      body: payload,
    });
    statusCode = response.status;
    status = response.ok ? "delivered" : response.status >= 500 ? "retrying" : "failed";
  } catch {
    status = "retrying";
  }
  await context.repository.recordClientWebhookDelivery({
    id: randomId("cwd", 20),
    jobId: job.id,
    eventId: signed.eventId,
    eventType,
    callbackUrlRedacted: redactUrl(job.callbackUrl),
    status,
    attemptCount: 1,
    lastStatusCode: statusCode,
    nextAttemptAt: status === "retrying" ? new Date(Date.now() + 60_000).toISOString() : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};
