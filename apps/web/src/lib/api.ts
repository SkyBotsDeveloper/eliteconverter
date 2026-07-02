import type {
  ApiResponse,
  CapabilitiesResponse,
  PublicJob,
  StatusResponse,
} from "@eliteconverter/shared";
import { responsibleUseNotice } from "@eliteconverter/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
const demoMode = import.meta.env.MODE === "test" || import.meta.env.VITE_DEMO_MODE === "true";

export interface CreateConversionInput {
  url: string;
  format: string;
  quality: string;
  permissionConfirmed: boolean;
  callbackUrl?: string;
}

interface CreateConversionResponse {
  jobId: string;
  status: string;
  statusUrl: string;
  accessToken?: string;
}

export const api = {
  capabilities: async (): Promise<CapabilitiesResponse> => {
    if (demoMode) return demoCapabilities;
    return unwrap(await request<CapabilitiesResponse>("/capabilities"));
  },
  createPublicConversion: async (
    input: CreateConversionInput,
  ): Promise<CreateConversionResponse> => {
    if (demoMode) return demoCreate(input);
    const created = unwrap(
      await request<CreateConversionResponse>("/public/conversions", {
        method: "POST",
        body: JSON.stringify({
          ...input,
          turnstileToken: "test-pass",
        }),
      }),
    );
    if (created.accessToken) storeJobAccessToken(created.jobId, created.accessToken);
    return created;
  },
  job: async (jobId: string): Promise<PublicJob> => {
    if (demoMode) return demoJob(jobId);
    return unwrap(
      await request<PublicJob>(`/conversions/${jobId}`, { headers: jobAuthHeaders(jobId) }),
    );
  },
  events: async (
    jobId: string,
  ): Promise<{
    events: Array<{ id: string; type: string; message: string; createdAt: string }>;
  }> => {
    if (demoMode) {
      return {
        events: [
          {
            id: "evt_1",
            type: "conversion.queued",
            message: "Conversion job queued.",
            createdAt: new Date().toISOString(),
          },
          {
            id: "evt_2",
            type: "conversion.completed",
            message: "Conversion completed.",
            createdAt: new Date().toISOString(),
          },
        ],
      };
    }
    return unwrap(
      await request(`/conversions/${jobId}/events`, { headers: jobAuthHeaders(jobId) }),
    );
  },
  cancel: async (jobId: string): Promise<PublicJob> => {
    if (demoMode) {
      const job = demoJob(jobId);
      const cancelled = {
        ...job,
        status: "cancelled" as const,
        progress: 100,
        currentStage: "cancelled",
      };
      demoJobs.set(jobId, cancelled);
      return cancelled;
    }
    return unwrap(
      await request(`/conversions/${jobId}/cancel`, {
        method: "POST",
        headers: jobAuthHeaders(jobId),
      }),
    );
  },
  refreshDownload: async (jobId: string): Promise<PublicJob> => {
    if (demoMode) return demoJob(jobId);
    return unwrap(
      await request(`/conversions/${jobId}/refresh-download`, {
        method: "POST",
        headers: jobAuthHeaders(jobId),
      }),
    );
  },
  download: async (jobId: string): Promise<{ url: string; expiresAt?: string }> => {
    if (demoMode) {
      return {
        url: "https://downloads.example.com/eliteconverter/demo.mp4?token=demo-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    }
    return unwrap(
      await request(`/conversions/${jobId}/download`, { headers: jobAuthHeaders(jobId) }),
    );
  },
  status: async (): Promise<StatusResponse> => {
    if (demoMode) {
      return {
        api: "operational",
        database: "operational",
        queue: "operational",
        conversionSystem: "operational",
        providerNetwork: "operational",
        incidents: [],
      };
    }
    return unwrap(await request<StatusResponse>("/status"));
  },
};

const request = async <T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> => {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return (await response.json()) as ApiResponse<T>;
};

const unwrap = <T>(response: ApiResponse<T>): T => {
  if (response.success) return response.data;
  throw new Error(response.error.message);
};

const jobTokenStorageKey = (jobId: string): string => `eliteconverter.job.${jobId}.accessToken`;

const storeJobAccessToken = (jobId: string, accessToken: string): void => {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(jobTokenStorageKey(jobId), accessToken);
};

const jobAuthHeaders = (jobId: string): Record<string, string> => {
  if (typeof window === "undefined") return {};
  const accessToken = window.sessionStorage.getItem(jobTokenStorageKey(jobId));
  return accessToken ? { "EliteConverter-Job-Token": accessToken } : {};
};

const demoCapabilities: CapabilitiesResponse = {
  product: "EliteConverter",
  tagline: "Convert Streams. Deliver Anywhere.",
  formats: ["mp4", "webm", "mkv", "mp3", "m4a"],
  qualities: ["source", "1080p", "720p", "480p", "audio"],
  qualityFormats: {
    source: ["mp4", "webm", "mkv", "mp3", "m4a"],
    "1080p": ["mp4", "webm", "mkv"],
    "720p": ["mp4", "webm", "mkv"],
    "480p": ["mp4", "webm", "mkv"],
    audio: ["mp3", "m4a"],
  },
  providers: [
    {
      id: "mock",
      displayName: "Mock Provider",
      capabilities: {
        formats: ["mp4", "webm", "mkv", "mp3", "m4a"],
        qualities: ["source", "1080p", "720p", "480p", "audio"],
        supportsWebhooks: true,
        supportsCancellation: true,
        supportsRefreshDownloadUrl: true,
        maxInputUrlLength: 4096,
      },
    },
  ],
  responsibleUseNotice,
};

const demoJobs = new Map<string, PublicJob>();

const demoCreate = (input: CreateConversionInput) => {
  const jobId = `ec_job_demo_${Date.now()}`;
  const now = new Date().toISOString();
  const job: PublicJob = {
    jobId,
    status: input.url.includes("mock=fail") ? "failed" : "completed",
    progress: 100,
    currentStage: input.url.includes("mock=fail") ? "failed" : "completed",
    format: input.format as PublicJob["format"],
    quality: input.quality as PublicJob["quality"],
    inputUrlRedacted: input.url.replace(/([?&](token|signature|key)=)[^&]+/gi, "$1<redacted>"),
    sourceHostname: "media.example.com",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    completedAt: now,
    outputUrl: input.url.includes("mock=fail")
      ? undefined
      : "https://downloads.example.com/eliteconverter/demo.mp4?token=<redacted>",
    outputMimeType: "video/mp4",
    outputFileSize: 1048576,
    error: input.url.includes("mock=fail")
      ? { code: "conversion_failed", message: "The conversion failed.", retryable: false }
      : undefined,
  };
  demoJobs.set(jobId, job);
  return { jobId, status: job.status, statusUrl: `/api/v1/conversions/${jobId}` };
};

const demoJob = (jobId: string): PublicJob => {
  const job = demoJobs.get(jobId);
  if (job) return job;
  const now = new Date().toISOString();
  return {
    jobId,
    status: "completed",
    progress: 100,
    currentStage: "completed",
    format: "mp4",
    quality: "source",
    inputUrlRedacted: "https://media.example.com/input.mp4",
    sourceHostname: "media.example.com",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    completedAt: now,
    outputUrl: "https://downloads.example.com/eliteconverter/demo.mp4?token=<redacted>",
    outputMimeType: "video/mp4",
    outputFileSize: 1048576,
  };
};
