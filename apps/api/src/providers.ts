import {
  CloudConvertProvider,
  GenericHttpProvider,
  MockProvider,
  PublicApiError,
  type ConversionProvider,
} from "@eliteconverter/shared";
import type { AppConfig } from "./types";

export const getProviders = (config: AppConfig): ConversionProvider[] => {
  const providers = new Map<string, ConversionProvider>();

  if (
    config.appEnv === "production" &&
    config.enabledProviders.some((providerId) => providerId.startsWith("mock"))
  ) {
    throw new PublicApiError(
      "internal_configuration_error",
      500,
      "MockProvider cannot be enabled in production",
    );
  }

  for (const providerId of config.enabledProviders.filter((candidate) =>
    candidate.startsWith("mock"),
  )) {
    providers.set(
      providerId,
      new MockProvider({
        id: providerId,
        displayName: providerId === "mock" ? "Mock Provider" : `Mock Provider ${providerId}`,
        formats: config.mockProviderFormats,
        qualities: config.mockProviderQualities,
      }),
    );
  }

  if (config.enabledProviders.includes("cloudconvert")) {
    providers.set(
      "cloudconvert",
      new CloudConvertProvider({
        baseUrl: config.cloudConvertProvider.baseUrl,
        apiKey: config.cloudConvertProvider.apiKey,
        webhookSigningSecret: config.cloudConvertProvider.webhookSigningSecret,
        formats: config.cloudConvertProvider.formats,
        qualities: config.cloudConvertProvider.qualities,
        timeoutMs: config.cloudConvertProvider.timeoutMs,
      }),
    );
  }

  if (config.enabledProviders.includes("generic")) {
    providers.set(
      "generic",
      new GenericHttpProvider({
        id: "generic",
        displayName: "Generic HTTP Provider",
        baseUrl: config.genericProvider.baseUrl,
        apiKey: config.genericProvider.apiKey,
        authHeader: config.genericProvider.authHeader,
        authScheme: config.genericProvider.authScheme,
        createPath: config.genericProvider.createPath,
        statusPath: config.genericProvider.statusPath,
        cancelPath: config.genericProvider.cancelPath,
        refreshPath: config.genericProvider.refreshPath,
        webhookSecret: config.genericProvider.webhookSecret,
        sourceExtensions: config.genericProvider.sourceExtensions,
        timeoutMs: config.genericProvider.timeoutMs,
        enabled: true,
        priority: 10,
        responseMappings: {
          providerJobId: "id",
          status: "status",
          outputUrl: "output.url",
          progress: "progress",
        },
      }),
    );
  }

  const ordered = config.providerPriority
    .map((providerId) => providers.get(providerId))
    .filter((provider): provider is ConversionProvider => Boolean(provider));

  if (!ordered.length) {
    throw new PublicApiError(
      "internal_configuration_error",
      500,
      "No enabled conversion provider is available",
    );
  }

  return ordered;
};
