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

export interface QueueProcessResult {
  status: "completed" | "skipped" | "retry_later" | "permanent_failure";
  error?: unknown;
}

const terminalStatuses = new Set<StoredJob["status"]>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const retryableWebhookStatuses = new Set([408, 425, 429]);
const permanentQueueErrorCodes: ReadonlySet<string> = new Set([
  "invalid_source_url",
  "unsupported_source",
  "unsupported_format",
  "unsupported_quality",
  "source_expired",
  "source_authentication_required",
  "drm_protected_source",
  "provider_permanent_failure",
  "validation_error",
]);

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
  const qualityFormats = Object.fromEntries(
    qualities.map((quality) => [
      quality,
      formats.filter((format) =>
        providerDetails.some(({ capabilities }) =>
          providerSupportsCombination(capabilities, format, quality),
        ),
      ),
    ]),
  );

  return {
    product: "EliteConverter",
    tagline: "Convert Streams. Deliver Anywhere.",
    formats,
    qualities,
    qualityFormats,
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
  const source = validateExternalUrl(parsed.url);
  const capabilities = await getCapabilities(context);
  assertSupportedRequest(parsed, capabilities, source.url);

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
  leaseOwner = randomId("lease", 16),
): Promise<QueueProcessResult> => {
  const now = new Date();
  const claim = await context.repository.claimQueueDelivery({
    dedupeKey: payload.dedupeKey,
    leaseOwner,
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + context.config.queueLeaseSeconds * 1000).toISOString(),
    maxAttempts: context.config.queueMaxDeliveryAttempts,
  });
  if (!claim) {
    const existing = await context.repository.getQueueDelivery(payload.dedupeKey);
    return existing?.status === "pending" || existing?.status === "processing"
      ? { status: "retry_later" }
      : { status: "skipped" };
  }

  try {
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

    await context.repository.completeQueueDelivery(payload.dedupeKey, leaseOwner);
    return { status: "completed" };
  } catch (error) {
    const retryable = shouldRetryQueueError(error);
    const exhausted = retryable && claim.attemptCount >= context.config.queueMaxDeliveryAttempts;
    if (!retryable || exhausted) {
      try {
        await recordPermanentQueueFailure(context, payload, error);
      } catch (recordError) {
        await context.repository.failQueueDelivery(
          payload.dedupeKey,
          leaseOwner,
          sanitizeDiagnostic(recordError),
          true,
        );
        throw recordError;
      }
      await context.repository.failQueueDelivery(
        payload.dedupeKey,
        leaseOwner,
        sanitizeDiagnostic(error),
        false,
      );
      return { status: "permanent_failure", error };
    }
    await context.repository.failQueueDelivery(
      payload.dedupeKey,
      leaseOwner,
      sanitizeDiagnostic(error),
      true,
    );
    throw error;
  }
};

export const submitProviderJob = async (jobId: string, context: RequestContext): Promise<void> => {
  const storedJob = await context.repository.getJobById(jobId);
  if (!storedJob || terminalStatuses.has(storedJob.status)) return;
  let job: StoredJob = storedJob;
  if (new Date(job.expiresAt) <= new Date()) {
    await expireJob(context, job);
    return;
  }
  if (job.providerJobId && job.providerId) {
    await schedulePoll(context, job, 0);
    return;
  }

  const configuredProviders = getProviders(context.config);
  const preferredProviderId = job.providerId && !job.providerJobId ? job.providerId : undefined;
  const providers = preferredProviderId
    ? [
        ...configuredProviders.filter((provider) => provider.id === preferredProviderId),
        ...configuredProviders.filter((provider) => provider.id !== preferredProviderId),
      ]
    : configuredProviders;
  let previousAttempts = await context.repository.listProviderAttempts(job.id);
  const previouslySubmittedProviderIds = new Set(
    previousAttempts
      .filter((attempt) => attempt.providerJobId)
      .map((attempt) => attempt.providerId),
  );
  let lastError: unknown;
  let circuitFallbackRecorded = false;

  for (const provider of providers) {
    const existingStartedAttempt = previousAttempts.find(
      (attempt) => attempt.providerId === provider.id && attempt.status === "started",
    );
    if (!existingStartedAttempt && previousAttempts.length >= context.config.maxProviderAttempts) {
      break;
    }
    if (previouslySubmittedProviderIds.has(provider.id) && provider.id !== preferredProviderId) {
      continue;
    }
    const capabilities = await provider.getCapabilities();
    if (!providerSupportsJob(capabilities, job)) continue;
    const health = await probeHealth(context, provider.id);
    if (health.state === "open") continue;
    if (preferredProviderId && provider.id !== preferredProviderId && !circuitFallbackRecorded) {
      await addEvent(
        context,
        job,
        "conversion.provider_fallback",
        "Preferred provider was unavailable; fallback provider selected.",
      );
      circuitFallbackRecorded = true;
    }

    const attempt =
      existingStartedAttempt ?? startAttempt(job, provider.id, previousAttempts.length + 1);
    try {
      if (!existingStartedAttempt) {
        await context.repository.addProviderAttempt(attempt);
        previousAttempts = [...previousAttempts, attempt];
        await addEvent(
          context,
          job,
          "conversion.provider_attempt_started",
          `Provider attempt ${attempt.attemptNumber} started.`,
        );
      }
      job = {
        ...job,
        status: "submitting",
        providerId: provider.id,
        providerJobId: undefined,
        providerAttemptCount: Math.max(job.providerAttemptCount, previousAttempts.length),
        currentStage: `submitting to ${provider.displayName}`,
      };
      await updateJob(context, job);
      const submitted = await provider.createJob(
        {
          jobId: job.id,
          idempotencyKey: job.idempotencyKey ?? `${job.id}:${provider.id}:${attempt.attemptNumber}`,
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
        providerAttemptCount: Math.max(job.providerAttemptCount, previousAttempts.length),
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
      job = updated;
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
      previousAttempts = await context.repository.listProviderAttempts(job.id);
      await context.repository.setProviderHealth(
        nextCircuitState(health, "failure", circuitOptions(context)),
      );
      if (!isRetryableError(publicError.code)) break;
    }
  }

  await failJob(context, job, lastError);
};

const shouldRetryQueueError = (error: unknown): boolean => {
  if (error instanceof PublicApiError) {
    return !permanentQueueErrorCodes.has(error.publicError.code);
  }
  return true;
};

const recordPermanentQueueFailure = async (
  context: RequestContext,
  payload: QueuePayload,
  error: unknown,
): Promise<void> => {
  if (payload.kind === "deliver_client_webhook" && payload.webhookEventId) {
    const event = await context.repository.getClientWebhookEvent(payload.webhookEventId);
    if (event && event.status !== "delivered" && event.status !== "permanently_failed") {
      await context.repository.updateClientWebhookEvent({
        ...event,
        status: "permanently_failed",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: sanitizeDiagnostic(error),
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  const job = await context.repository.getJobById(payload.jobId);
  if (!job || terminalStatuses.has(job.status)) return;
  await failJob(
    context,
    job,
    error instanceof PublicApiError ? error : new PublicApiError("internal_error", 500),
  );
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
      if (status.retryable) {
        await retryProviderOrFallback(
          context,
          job,
          new PublicApiError(status.errorCode ?? "provider_temporary_failure", 502),
        );
        return;
      }
      const error = new PublicApiError(status.errorCode ?? "conversion_failed", 400);
      const newlyFailed = await finishCurrentProviderAttempt(context, job, "failed", error);
      if (newlyFailed) {
        await context.repository.setProviderHealth(
          nextCircuitState(
            await getHealth(context, provider.id),
            "failure",
            circuitOptions(context),
          ),
        );
      }
      await failJob(context, job, error);
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
    if (isRetryableError(publicError.code)) {
      await retryProviderOrFallback(context, job, error);
      return;
    }
    const newlyFailed = await finishCurrentProviderAttempt(context, job, "failed", error);
    if (newlyFailed && job.providerId) {
      await context.repository.setProviderHealth(
        nextCircuitState(
          await getHealth(context, job.providerId),
          "failure",
          circuitOptions(context),
        ),
      );
    }
    await failJob(context, job, error);
  }
};

const retryProviderOrFallback = async (
  context: RequestContext,
  staleJob: StoredJob,
  error: unknown,
): Promise<void> => {
  const job = (await context.repository.getJobById(staleJob.id)) ?? staleJob;
  if (terminalStatuses.has(job.status)) return;
  if (job.status === "cancel_requested" || job.cancellationState === "requested") {
    await cancelStoredJob(job, context);
    return;
  }
  const newlyFailed = await finishCurrentProviderAttempt(context, job, "failed", error);
  if (newlyFailed && job.providerId) {
    await context.repository.setProviderHealth(
      nextCircuitState(
        await getHealth(context, job.providerId),
        "failure",
        circuitOptions(context),
      ),
    );
  }
  const attempts = await context.repository.listProviderAttempts(job.id);
  if (
    job.providerId &&
    job.retryCount < context.config.maxRetryAttempts &&
    attempts.length < context.config.maxProviderAttempts
  ) {
    const retrying = {
      ...job,
      providerJobId: undefined,
      status: "retrying",
      retryCount: job.retryCount + 1,
      providerAttemptCount: Math.max(job.providerAttemptCount, attempts.length),
      currentStage: "provider retry scheduled",
      nextPollAt: undefined,
    } satisfies StoredJob;
    await updateJob(context, retrying);
    await addEvent(
      context,
      retrying,
      "conversion.provider_retry",
      `Retrying ${job.providerId} after a temporary terminal failure.`,
    );
    await enqueueStage(context, {
      kind: "submit_provider_job",
      jobId: retrying.id,
      requestId: context.requestId,
      dedupeKey: `${retrying.id}:submit_provider_job:provider-retry:${job.providerId}:${retrying.retryCount}`,
    });
    return;
  }

  const attemptedProviders = new Set(
    attempts.filter((attempt) => attempt.providerJobId).map((attempt) => attempt.providerId),
  );
  const hasFallbackProvider = getProviders(context.config).some(
    (provider) => !attemptedProviders.has(provider.id),
  );
  if (!hasFallbackProvider || attempts.length >= context.config.maxProviderAttempts) {
    await failJob(context, job, error);
    return;
  }

  const fallback = {
    ...job,
    providerId: undefined,
    providerJobId: undefined,
    status: "retrying",
    retryCount: 0,
    providerAttemptCount: Math.max(job.providerAttemptCount, attempts.length),
    currentStage: "provider fallback scheduled",
    nextPollAt: undefined,
  } satisfies StoredJob;
  await updateJob(context, fallback);
  await addEvent(
    context,
    fallback,
    "conversion.provider_fallback",
    "Provider failed after acceptance; fallback provider scheduled.",
  );
  await enqueueStage(context, {
    kind: "submit_provider_job",
    jobId: fallback.id,
    requestId: context.requestId,
    dedupeKey: `${fallback.id}:submit_provider_job:fallback:${fallback.providerAttemptCount}`,
  });
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
    await finishCurrentProviderAttempt(context, job, "cancelled");
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
  if (
    job.outputUrlPrivate &&
    (!job.outputUrlExpiresAt || new Date(job.outputUrlExpiresAt).getTime() > Date.now())
  ) {
    await validateProviderDownload(
      {
        url: job.outputUrlPrivate,
        expiresAt: job.outputUrlExpiresAt,
        mimeType: job.outputMimeType,
        fileSize: job.outputFileSize,
      },
      context,
    );
    return job;
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
  if (job.outputUrlPrivate && download.url === job.outputUrlPrivate) {
    throw new PublicApiError("output_expired", 400, "Provider returned the expired output URL");
  }
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
  if (job.outputUrlExpiresAt && new Date(job.outputUrlExpiresAt).getTime() <= Date.now()) {
    throw new PublicApiError("output_expired", 410);
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
    const error = new PublicApiError(
      event.errorCode ??
        (event.retryable ? "provider_temporary_failure" : "provider_permanent_failure"),
      event.retryable ? 502 : 400,
    );
    if (event.retryable) {
      await retryProviderOrFallback(context, job, error);
    } else {
      const newlyFailed = await finishCurrentProviderAttempt(context, job, "failed", error);
      if (newlyFailed && job.providerId) {
        await context.repository.setProviderHealth(
          nextCircuitState(
            await getHealth(context, job.providerId),
            "failure",
            circuitOptions(context),
          ),
        );
      }
      await failJob(context, job, error);
    }
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

  const scheduledLeaseOwner = randomId("lease", 16);
  const dueTasks = await context.repository.claimDueScheduledTasks(
    now,
    50,
    scheduledLeaseOwner,
    new Date(Date.now() + context.config.scheduledTaskLeaseSeconds * 1000).toISOString(),
  );
  for (const task of dueTasks) {
    try {
      const result = await processQueuePayload(task.payload, context, randomId("lease", 16));
      if (result.status === "retry_later") {
        await context.repository.failScheduledTask(
          task.dedupeKey,
          "Queue delivery is already processing or awaiting terminal failure recording",
          scheduledLeaseOwner,
        );
        continue;
      }
      await context.repository.completeScheduledTask(task.dedupeKey, scheduledLeaseOwner);
      processed += 1;
    } catch (error) {
      await context.repository.failScheduledTask(
        task.dedupeKey,
        sanitizeDiagnostic(error),
        scheduledLeaseOwner,
      );
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
        dedupeKey: `${job.id}:poll_provider_job:${job.providerAttemptCount}:${job.pollAttemptCount + 1}`,
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
      dedupeKey: `${job.id}:poll_provider_job:${job.providerAttemptCount}:${job.pollAttemptCount + 1}`,
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
    const result = await processQueuePayload(payload, context);
    if (result.status !== "retry_later") {
      await context.repository.completeScheduledTask(payload.dedupeKey);
    }
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
  const leaseOwner = randomId("lease", 16);
  const now = new Date();
  const delivering = await context.repository.claimClientWebhookEvent(
    eventId,
    leaseOwner,
    now.toISOString(),
    new Date(now.getTime() + context.config.clientWebhookLeaseSeconds * 1000).toISOString(),
    context.config.clientWebhookMaxAttempts,
  );
  if (!delivering) {
    const event = await context.repository.getClientWebhookEvent(eventId);
    if (
      event &&
      event.status !== "delivered" &&
      event.status !== "permanently_failed" &&
      event.attemptCount >= context.config.clientWebhookMaxAttempts
    ) {
      await context.repository.updateClientWebhookEvent({
        ...event,
        status: "permanently_failed",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: "Maximum delivery attempts exhausted",
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  let statusCode: number | undefined;
  let nextStatus: ClientWebhookEvent["status"] = "delivered";
  let lastError: string | undefined;
  try {
    const signed = await signWebhookPayload(
      context.config.clientWebhookSigningSecret,
      delivering.payloadJson,
      Math.floor(Date.now() / 1000).toString(),
      delivering.eventId,
    );
    const response = await sendClientWebhookWithRedirects(delivering, signed, context);
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
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastStatusCode: statusCode,
    lastError,
    nextAttemptAt,
    updatedAt: new Date().toISOString(),
  };
  await context.repository.updateClientWebhookEvent(updated);
  await context.repository.recordClientWebhookDelivery({
    id: randomId("cwd", 20),
    jobId: delivering.jobId,
    eventId: delivering.eventId,
    eventType: delivering.eventType,
    callbackUrlRedacted: delivering.callbackUrlRedacted,
    status: nextStatus,
    attemptCount: updated.attemptCount,
    lastStatusCode: statusCode,
    nextAttemptAt,
    createdAt: delivering.createdAt,
    updatedAt: updated.updatedAt,
  });

  if (nextStatus === "retrying" && nextAttemptAt) {
    await enqueueStage(
      context,
      {
        kind: "deliver_client_webhook",
        jobId: delivering.jobId,
        requestId: context.requestId,
        dedupeKey: `${delivering.jobId}:deliver_client_webhook:${delivering.eventId}:${updated.attemptCount}`,
        webhookEventId: delivering.eventId,
      },
      nextAttemptAt,
    );
  }
};

const sendClientWebhookWithRedirects = async (
  event: ClientWebhookEvent,
  signed: Awaited<ReturnType<typeof signWebhookPayload>>,
  context: RequestContext,
): Promise<Response> => {
  let current = validateCallbackUrl(event.callbackUrlPrivate, context).url;
  const initialHost = new URL(current).host;
  const maxRedirects = 3;
  const deadline = Date.now() + context.config.clientWebhookTimeoutMs;
  const visited = new Set([current]);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const headers = new Headers(clientWebhookHeaders(signed));
    const currentHost = new URL(current).host;
    if (currentHost !== initialHost) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new PublicApiError("source_unreachable", 504, "Client webhook request timed out");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response: Response;
    try {
      response = await context.fetcher(current, {
        method: "POST",
        headers,
        body: event.payloadJson,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new PublicApiError("source_unreachable", 502, "Client webhook request failed");
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new PublicApiError("invalid_source_url", 400, "Callback redirect missing Location");
      }
      const next = new URL(location, current).toString();
      const validatedNext = validateCallbackUrl(next, context).url;
      if (visited.has(validatedNext)) {
        throw new PublicApiError("invalid_source_url", 400, "Callback redirect loop detected");
      }
      visited.add(validatedNext);
      current = validatedNext;
      continue;
    }

    return response;
  }

  throw new PublicApiError("invalid_source_url", 400, "Too many callback redirects");
};

const completeJob = async (
  context: RequestContext,
  job: StoredJob,
  download: ProviderDownloadResult,
): Promise<StoredJob> => {
  await validateProviderDownload(download, context);
  await finishCurrentProviderAttempt(context, job, "completed");
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

const startAttempt = (
  job: StoredJob,
  providerId: string,
  attemptNumber: number,
): StoredProviderAttempt => ({
  id: randomId("att", 20),
  jobId: job.id,
  providerId,
  status: "started",
  attemptNumber,
  retryable: false,
  startedAt: new Date().toISOString(),
});

const finishCurrentProviderAttempt = async (
  context: RequestContext,
  job: StoredJob,
  status: "completed" | "failed" | "cancelled",
  error?: unknown,
): Promise<boolean> => {
  if (!job.providerId || !job.providerJobId) return false;
  const attempts = await context.repository.listProviderAttempts(job.id);
  const attempt = [...attempts]
    .reverse()
    .find(
      (candidate) =>
        candidate.providerId === job.providerId && candidate.providerJobId === job.providerJobId,
    );
  if (!attempt || attempt.status === status) return false;
  const publicError = error ? toPublicError(error) : undefined;
  await context.repository.addProviderAttempt({
    ...attempt,
    status,
    errorCode: publicError?.code,
    retryable: publicError?.retryable ?? false,
    finishedAt: new Date().toISOString(),
  });
  return true;
};

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
  sourceUrl: string,
): void => {
  if (!capabilities.formats.includes(input.format)) {
    throw new PublicApiError("unsupported_format", 400);
  }
  if (!capabilities.qualities.includes(input.quality)) {
    throw new PublicApiError("unsupported_quality", 400);
  }
  const combinationSupported = capabilities.providers.some(({ capabilities: provider }) =>
    providerSupportsCombination(provider, input.format, input.quality),
  );
  if (!combinationSupported) {
    throw new PublicApiError("unsupported_quality", 400);
  }
  const maxInputUrlLength = Math.min(
    ...capabilities.providers.map((provider) => provider.capabilities.maxInputUrlLength),
  );
  if (input.url.length > maxInputUrlLength) {
    throw new PublicApiError("invalid_source_url", 400, "Input URL exceeds provider limit");
  }
  const extension = sourceExtension(sourceUrl);
  const sourceSupported = capabilities.providers.some((provider) => {
    const supported = provider.capabilities.sourceExtensions;
    return !supported?.length || (extension ? supported.includes(extension) : false);
  });
  if (!sourceSupported) {
    throw new PublicApiError("unsupported_source", 400);
  }
};

const providerSupportsJob = (capabilities: ProviderCapabilities, job: StoredJob): boolean => {
  if (!providerSupportsCombination(capabilities, job.format, job.quality)) {
    return false;
  }
  if (!capabilities.sourceExtensions?.length) return true;
  const extension = sourceExtension(job.inputUrl);
  return extension ? capabilities.sourceExtensions.includes(extension) : false;
};

const providerSupportsCombination = (
  capabilities: ProviderCapabilities,
  format: OutputFormat,
  quality: QualityOption,
): boolean => {
  if (!capabilities.formats.includes(format) || !capabilities.qualities.includes(quality)) {
    return false;
  }
  const qualityFormats = capabilities.qualityFormats?.[quality];
  return !qualityFormats || qualityFormats.includes(format);
};

const sourceExtension = (rawUrl: string): string | undefined => {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match?.[1];
  } catch {
    return undefined;
  }
};

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
