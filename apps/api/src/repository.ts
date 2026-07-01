import type { CircuitBreakerSnapshot, JobEvent, PublicErrorCode } from "@eliteconverter/shared";
import type { Env, StoredApiKey, StoredIncident, StoredJob, StoredProviderAttempt } from "./types";

export interface Repository {
  insertApiKey(key: StoredApiKey): Promise<void>;
  findApiKeyByHash(hash: string): Promise<StoredApiKey | undefined>;
  updateApiKeyLastUsed(id: string, at: string): Promise<void>;
  revokeApiKey(id: string, at: string): Promise<void>;
  insertJob(job: StoredJob): Promise<void>;
  updateJob(job: StoredJob): Promise<void>;
  getJobById(id: string): Promise<StoredJob | undefined>;
  getJobByPublicId(publicId: string): Promise<StoredJob | undefined>;
  findJobByIdempotency(scope: string, idempotencyKey: string): Promise<StoredJob | undefined>;
  insertIdempotency(
    scope: string,
    idempotencyKey: string,
    fingerprint: string,
    jobId: string,
  ): Promise<void>;
  addJobEvent(event: JobEvent): Promise<void>;
  listJobEvents(jobId: string): Promise<JobEvent[]>;
  addProviderAttempt(attempt: StoredProviderAttempt): Promise<void>;
  getProviderHealth(providerId: string): Promise<CircuitBreakerSnapshot | undefined>;
  setProviderHealth(snapshot: CircuitBreakerSnapshot): Promise<void>;
  recordProviderWebhookEvent(input: {
    id: string;
    providerId: string;
    providerEventId: string;
    providerJobId: string;
    eventType: string;
    receivedAt: string;
  }): Promise<boolean>;
  recordClientWebhookDelivery(input: {
    id: string;
    jobId: string;
    eventId: string;
    eventType: string;
    callbackUrlRedacted: string;
    status: string;
    attemptCount: number;
    lastStatusCode?: number;
    nextAttemptAt?: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  listActiveJobs(): Promise<StoredJob[]>;
  listStuckJobs(before: string): Promise<StoredJob[]>;
  listIncidents(): Promise<StoredIncident[]>;
  insertIncident(incident: StoredIncident): Promise<void>;
  countActiveJobsForScope(scope: string): Promise<number>;
}

export class MemoryRepository implements Repository {
  private readonly apiKeys = new Map<string, StoredApiKey>();
  private readonly jobs = new Map<string, StoredJob>();
  private readonly publicJobIndex = new Map<string, string>();
  private readonly events = new Map<string, JobEvent[]>();
  private readonly idempotency = new Map<string, { fingerprint: string; jobId: string }>();
  private readonly providerHealth = new Map<string, CircuitBreakerSnapshot>();
  private readonly providerWebhookEvents = new Set<string>();
  private readonly incidents = new Map<string, StoredIncident>();

  async insertApiKey(key: StoredApiKey): Promise<void> {
    this.apiKeys.set(key.keyHash, key);
  }

  async findApiKeyByHash(hash: string): Promise<StoredApiKey | undefined> {
    return this.apiKeys.get(hash);
  }

  async updateApiKeyLastUsed(id: string, at: string): Promise<void> {
    for (const [hash, key] of this.apiKeys.entries()) {
      if (key.id === id) this.apiKeys.set(hash, { ...key, lastUsedAt: at });
    }
  }

  async revokeApiKey(id: string, at: string): Promise<void> {
    for (const [hash, key] of this.apiKeys.entries()) {
      if (key.id === id) this.apiKeys.set(hash, { ...key, status: "revoked", revokedAt: at });
    }
  }

  async insertJob(job: StoredJob): Promise<void> {
    this.jobs.set(job.id, job);
    this.publicJobIndex.set(job.publicId, job.id);
  }

  async updateJob(job: StoredJob): Promise<void> {
    this.jobs.set(job.id, job);
    this.publicJobIndex.set(job.publicId, job.id);
  }

  async getJobById(id: string): Promise<StoredJob | undefined> {
    return this.jobs.get(id);
  }

  async getJobByPublicId(publicId: string): Promise<StoredJob | undefined> {
    const id = this.publicJobIndex.get(publicId);
    return id ? this.jobs.get(id) : undefined;
  }

  async findJobByIdempotency(
    scope: string,
    idempotencyKey: string,
  ): Promise<StoredJob | undefined> {
    const record = this.idempotency.get(`${scope}:${idempotencyKey}`);
    return record ? this.jobs.get(record.jobId) : undefined;
  }

  async insertIdempotency(
    scope: string,
    idempotencyKey: string,
    fingerprint: string,
    jobId: string,
  ): Promise<void> {
    this.idempotency.set(`${scope}:${idempotencyKey}`, { fingerprint, jobId });
  }

  async addJobEvent(event: JobEvent): Promise<void> {
    const list = this.events.get(event.jobId) ?? [];
    this.events.set(event.jobId, [...list, event]);
  }

  async listJobEvents(jobId: string): Promise<JobEvent[]> {
    return this.events.get(jobId) ?? [];
  }

  async addProviderAttempt(_attempt: StoredProviderAttempt): Promise<void> {
    return;
  }

  async getProviderHealth(providerId: string): Promise<CircuitBreakerSnapshot | undefined> {
    return this.providerHealth.get(providerId);
  }

  async setProviderHealth(snapshot: CircuitBreakerSnapshot): Promise<void> {
    this.providerHealth.set(snapshot.providerId, snapshot);
  }

  async recordProviderWebhookEvent(input: {
    providerId: string;
    providerEventId: string;
  }): Promise<boolean> {
    const key = `${input.providerId}:${input.providerEventId}`;
    if (this.providerWebhookEvents.has(key)) return false;
    this.providerWebhookEvents.add(key);
    return true;
  }

  async recordClientWebhookDelivery(): Promise<void> {
    return;
  }

  async listActiveJobs(): Promise<StoredJob[]> {
    return [...this.jobs.values()].filter((job) => !terminalStatuses.has(job.status));
  }

  async listStuckJobs(before: string): Promise<StoredJob[]> {
    return [...this.jobs.values()].filter(
      (job) => !terminalStatuses.has(job.status) && job.updatedAt < before,
    );
  }

  async listIncidents(): Promise<StoredIncident[]> {
    return [...this.incidents.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async insertIncident(incident: StoredIncident): Promise<void> {
    this.incidents.set(incident.id, incident);
  }

  async countActiveJobsForScope(scope: string): Promise<number> {
    return [...this.jobs.values()].filter((job) => {
      const jobScope = job.apiKeyId
        ? `api:${job.apiKeyId}`
        : `anon:${job.anonymousSessionId ?? "unknown"}`;
      return jobScope === scope && !terminalStatuses.has(job.status);
    }).length;
  }
}

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  async insertApiKey(key: StoredApiKey): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO api_keys (id, owner_id, name, prefix, key_hash, status, scopes, created_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        key.id,
        key.ownerId,
        key.name,
        key.prefix,
        key.keyHash,
        key.status,
        JSON.stringify(key.scopes),
        key.createdAt,
        key.revokedAt ?? null,
        key.lastUsedAt ?? null,
      )
      .run();
  }

  async findApiKeyByHash(hash: string): Promise<StoredApiKey | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1")
      .bind(hash)
      .first<ApiKeyRow>();
    return row ? mapApiKey(row) : undefined;
  }

  async updateApiKeyLastUsed(id: string, at: string): Promise<void> {
    await this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(at, id).run();
  }

  async revokeApiKey(id: string, at: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?")
      .bind(at, id)
      .run();
  }

  async insertJob(job: StoredJob): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO conversion_jobs (
          id, public_id, owner_id, anonymous_session_id, api_key_id, input_url,
          input_url_redacted, source_hostname, format, quality, status, progress,
          current_stage, provider_id, provider_job_id, retry_count, provider_attempt_count,
          public_error_code, public_error_message, internal_diagnostic, created_at, updated_at,
          expires_at, completed_at, output_url, output_url_expires_at, output_mime_type,
          output_file_size, idempotency_key, request_fingerprint, callback_url, cancellation_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...jobValues(job))
      .run();
  }

  async updateJob(job: StoredJob): Promise<void> {
    await this.db
      .prepare(
        `UPDATE conversion_jobs SET
          owner_id = ?, anonymous_session_id = ?, api_key_id = ?, input_url = ?,
          input_url_redacted = ?, source_hostname = ?, format = ?, quality = ?, status = ?,
          progress = ?, current_stage = ?, provider_id = ?, provider_job_id = ?, retry_count = ?,
          provider_attempt_count = ?, public_error_code = ?, public_error_message = ?,
          internal_diagnostic = ?, updated_at = ?, expires_at = ?, completed_at = ?, output_url = ?,
          output_url_expires_at = ?, output_mime_type = ?, output_file_size = ?,
          idempotency_key = ?, request_fingerprint = ?, callback_url = ?, cancellation_state = ?
          WHERE id = ?`,
      )
      .bind(...jobUpdateValues(job))
      .run();
  }

  async getJobById(id: string): Promise<StoredJob | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM conversion_jobs WHERE id = ? LIMIT 1")
      .bind(id)
      .first<JobRow>();
    return row ? mapJob(row) : undefined;
  }

  async getJobByPublicId(publicId: string): Promise<StoredJob | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM conversion_jobs WHERE public_id = ? LIMIT 1")
      .bind(publicId)
      .first<JobRow>();
    return row ? mapJob(row) : undefined;
  }

  async findJobByIdempotency(
    scope: string,
    idempotencyKey: string,
  ): Promise<StoredJob | undefined> {
    const row = await this.db
      .prepare(
        "SELECT conversion_jobs.* FROM idempotency_records JOIN conversion_jobs ON conversion_jobs.id = idempotency_records.job_id WHERE scope = ? AND idempotency_key = ? LIMIT 1",
      )
      .bind(scope, idempotencyKey)
      .first<JobRow>();
    return row ? mapJob(row) : undefined;
  }

  async insertIdempotency(
    scope: string,
    idempotencyKey: string,
    fingerprint: string,
    jobId: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO idempotency_records (id, scope, idempotency_key, request_fingerprint, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        scope,
        idempotencyKey,
        fingerprint,
        jobId,
        new Date().toISOString(),
      )
      .run();
  }

  async addJobEvent(event: JobEvent): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO conversion_job_events (id, job_id, public_job_id, type, message, safe_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        event.id,
        event.jobId,
        event.jobId,
        event.type,
        event.message,
        event.safeDetails ?? null,
        event.createdAt,
      )
      .run();
  }

  async listJobEvents(jobId: string): Promise<JobEvent[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM conversion_job_events WHERE job_id = ? ORDER BY created_at ASC")
      .bind(jobId)
      .all<JobEventRow>();
    return results.map(mapJobEvent);
  }

  async addProviderAttempt(attempt: StoredProviderAttempt): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO provider_attempts (id, job_id, provider_id, status, attempt_number, provider_job_id, error_code, retryable, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        attempt.id,
        attempt.jobId,
        attempt.providerId,
        attempt.status,
        attempt.attemptNumber,
        attempt.providerJobId ?? null,
        attempt.errorCode ?? null,
        attempt.retryable ? 1 : 0,
        attempt.startedAt,
        attempt.finishedAt ?? null,
      )
      .run();
  }

  async getProviderHealth(providerId: string): Promise<CircuitBreakerSnapshot | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM provider_health WHERE provider_id = ? LIMIT 1")
      .bind(providerId)
      .first<ProviderHealthRow>();
    return row ? mapProviderHealth(row) : undefined;
  }

  async setProviderHealth(snapshot: CircuitBreakerSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_health (provider_id, state, consecutive_failures, recent_successes,
          recent_failures, last_failure_at, cooldown_until, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider_id) DO UPDATE SET state = excluded.state,
          consecutive_failures = excluded.consecutive_failures,
          recent_successes = excluded.recent_successes, recent_failures = excluded.recent_failures,
          last_failure_at = excluded.last_failure_at, cooldown_until = excluded.cooldown_until,
          updated_at = excluded.updated_at`,
      )
      .bind(
        snapshot.providerId,
        snapshot.state,
        snapshot.consecutiveFailures,
        snapshot.recentSuccesses,
        snapshot.recentFailures,
        snapshot.lastFailureAt ?? null,
        snapshot.cooldownUntil ?? null,
        snapshot.updatedAt,
      )
      .run();
  }

  async recordProviderWebhookEvent(input: {
    id: string;
    providerId: string;
    providerEventId: string;
    providerJobId: string;
    eventType: string;
    receivedAt: string;
  }): Promise<boolean> {
    try {
      await this.db
        .prepare(
          "INSERT INTO provider_webhook_events (id, provider_id, provider_event_id, provider_job_id, event_type, received_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          input.id,
          input.providerId,
          input.providerEventId,
          input.providerJobId,
          input.eventType,
          input.receivedAt,
        )
        .run();
      return true;
    } catch {
      return false;
    }
  }

  async recordClientWebhookDelivery(input: {
    id: string;
    jobId: string;
    eventId: string;
    eventType: string;
    callbackUrlRedacted: string;
    status: string;
    attemptCount: number;
    lastStatusCode?: number;
    nextAttemptAt?: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO client_webhook_deliveries (id, job_id, event_id, event_type, callback_url_redacted, status, attempt_count, last_status_code, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.id,
        input.jobId,
        input.eventId,
        input.eventType,
        input.callbackUrlRedacted,
        input.status,
        input.attemptCount,
        input.lastStatusCode ?? null,
        input.nextAttemptAt ?? null,
        input.createdAt,
        input.updatedAt,
      )
      .run();
  }

  async listActiveJobs(): Promise<StoredJob[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM conversion_jobs WHERE status NOT IN ('completed','failed','cancelled','expired') ORDER BY updated_at ASC LIMIT 100",
      )
      .all<JobRow>();
    return results.map(mapJob);
  }

  async listStuckJobs(before: string): Promise<StoredJob[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM conversion_jobs WHERE status NOT IN ('completed','failed','cancelled','expired') AND updated_at < ? ORDER BY updated_at ASC LIMIT 100",
      )
      .bind(before)
      .all<JobRow>();
    return results.map(mapJob);
  }

  async listIncidents(): Promise<StoredIncident[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM incidents ORDER BY updated_at DESC LIMIT 20")
      .all<IncidentRow>();
    return results.map(mapIncident);
  }

  async insertIncident(incident: StoredIncident): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO incidents (id, title, status, severity, message, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        incident.id,
        incident.title,
        incident.status,
        incident.severity,
        incident.message,
        incident.createdAt,
        incident.updatedAt,
        incident.resolvedAt ?? null,
      )
      .run();
  }

  async countActiveJobsForScope(scope: string): Promise<number> {
    const [kind, id] = scope.split(":");
    const column = kind === "api" ? "api_key_id" : "anonymous_session_id";
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM conversion_jobs WHERE ${column} = ? AND status NOT IN ('completed','failed','cancelled','expired')`,
      )
      .bind(id)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
}

export const getRepository = (env: Env): Repository => {
  if (env.TEST_REPOSITORY) return env.TEST_REPOSITORY;
  if (env.DB) return new D1Repository(env.DB);
  if (!globalMemoryRepository) globalMemoryRepository = new MemoryRepository();
  return globalMemoryRepository;
};

let globalMemoryRepository: MemoryRepository | undefined;

const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

interface ApiKeyRow {
  id: string;
  owner_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  status: "active" | "revoked";
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

interface JobRow {
  id: string;
  public_id: string;
  owner_id: string | null;
  anonymous_session_id: string | null;
  api_key_id: string | null;
  input_url: string;
  input_url_redacted: string;
  source_hostname: string;
  format: StoredJob["format"];
  quality: StoredJob["quality"];
  status: StoredJob["status"];
  progress: number;
  current_stage: string;
  provider_id: string | null;
  provider_job_id: string | null;
  retry_count: number;
  provider_attempt_count: number;
  public_error_code: PublicErrorCode | null;
  public_error_message: string | null;
  internal_diagnostic: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
  output_url: string | null;
  output_url_expires_at: string | null;
  output_mime_type: string | null;
  output_file_size: number | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  callback_url: string | null;
  cancellation_state: string | null;
}

interface JobEventRow {
  id: string;
  job_id: string;
  type: string;
  message: string;
  safe_details: string | null;
  created_at: string;
}

interface ProviderHealthRow {
  provider_id: string;
  state: CircuitBreakerSnapshot["state"];
  consecutive_failures: number;
  recent_successes: number;
  recent_failures: number;
  last_failure_at: string | null;
  cooldown_until: string | null;
  updated_at: string;
}

interface IncidentRow {
  id: string;
  title: string;
  status: string;
  severity: string;
  message: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const mapApiKey = (row: ApiKeyRow): StoredApiKey => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  prefix: row.prefix,
  keyHash: row.key_hash,
  status: row.status,
  scopes: JSON.parse(row.scopes) as string[],
  createdAt: row.created_at,
  revokedAt: row.revoked_at ?? undefined,
  lastUsedAt: row.last_used_at ?? undefined,
});

const mapJob = (row: JobRow): StoredJob => ({
  id: row.id,
  publicId: row.public_id,
  ownerId: row.owner_id ?? undefined,
  anonymousSessionId: row.anonymous_session_id ?? undefined,
  apiKeyId: row.api_key_id ?? undefined,
  inputUrl: row.input_url,
  inputUrlRedacted: row.input_url_redacted,
  sourceHostname: row.source_hostname,
  format: row.format,
  quality: row.quality,
  status: row.status,
  progress: row.progress,
  currentStage: row.current_stage,
  providerId: row.provider_id ?? undefined,
  providerJobId: row.provider_job_id ?? undefined,
  retryCount: row.retry_count,
  providerAttemptCount: row.provider_attempt_count,
  publicErrorCode: row.public_error_code ?? undefined,
  publicErrorMessage: row.public_error_message ?? undefined,
  internalDiagnostic: row.internal_diagnostic ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  completedAt: row.completed_at ?? undefined,
  outputUrl: row.output_url ?? undefined,
  outputUrlExpiresAt: row.output_url_expires_at ?? undefined,
  outputMimeType: row.output_mime_type ?? undefined,
  outputFileSize: row.output_file_size ?? undefined,
  idempotencyKey: row.idempotency_key ?? undefined,
  requestFingerprint: row.request_fingerprint ?? undefined,
  callbackUrl: row.callback_url ?? undefined,
  cancellationState: row.cancellation_state ?? undefined,
});

const mapJobEvent = (row: JobEventRow): JobEvent => ({
  id: row.id,
  jobId: row.job_id,
  type: row.type,
  message: row.message,
  safeDetails: row.safe_details ?? undefined,
  createdAt: row.created_at,
});

const mapProviderHealth = (row: ProviderHealthRow): CircuitBreakerSnapshot => ({
  providerId: row.provider_id,
  state: row.state,
  consecutiveFailures: row.consecutive_failures,
  recentSuccesses: row.recent_successes,
  recentFailures: row.recent_failures,
  lastFailureAt: row.last_failure_at ?? undefined,
  cooldownUntil: row.cooldown_until ?? undefined,
  updatedAt: row.updated_at,
});

const mapIncident = (row: IncidentRow): StoredIncident => ({
  id: row.id,
  title: row.title,
  status: row.status,
  severity: row.severity,
  message: row.message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  resolvedAt: row.resolved_at ?? undefined,
});

const jobValues = (job: StoredJob): unknown[] => [
  job.id,
  job.publicId,
  job.ownerId ?? null,
  job.anonymousSessionId ?? null,
  job.apiKeyId ?? null,
  job.inputUrl,
  job.inputUrlRedacted,
  job.sourceHostname,
  job.format,
  job.quality,
  job.status,
  job.progress,
  job.currentStage,
  job.providerId ?? null,
  job.providerJobId ?? null,
  job.retryCount,
  job.providerAttemptCount,
  job.publicErrorCode ?? null,
  job.publicErrorMessage ?? null,
  job.internalDiagnostic ?? null,
  job.createdAt,
  job.updatedAt,
  job.expiresAt,
  job.completedAt ?? null,
  job.outputUrl ?? null,
  job.outputUrlExpiresAt ?? null,
  job.outputMimeType ?? null,
  job.outputFileSize ?? null,
  job.idempotencyKey ?? null,
  job.requestFingerprint ?? null,
  job.callbackUrl ?? null,
  job.cancellationState ?? null,
];

const jobUpdateValues = (job: StoredJob): unknown[] => [
  job.ownerId ?? null,
  job.anonymousSessionId ?? null,
  job.apiKeyId ?? null,
  job.inputUrl,
  job.inputUrlRedacted,
  job.sourceHostname,
  job.format,
  job.quality,
  job.status,
  job.progress,
  job.currentStage,
  job.providerId ?? null,
  job.providerJobId ?? null,
  job.retryCount,
  job.providerAttemptCount,
  job.publicErrorCode ?? null,
  job.publicErrorMessage ?? null,
  job.internalDiagnostic ?? null,
  job.updatedAt,
  job.expiresAt,
  job.completedAt ?? null,
  job.outputUrl ?? null,
  job.outputUrlExpiresAt ?? null,
  job.outputMimeType ?? null,
  job.outputFileSize ?? null,
  job.idempotencyKey ?? null,
  job.requestFingerprint ?? null,
  job.callbackUrl ?? null,
  job.cancellationState ?? null,
  job.id,
];
