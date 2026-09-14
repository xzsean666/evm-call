import http from "node:http";
import https from "node:https";

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  isAxiosError,
} from "axios";

import {
  HttpTransportError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "./HttpTransport";

const defaultHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 60_000,
});

const defaultHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 60_000,
});

export interface AxiosHttpTransportOptions {
  readonly axiosInstance?: AxiosInstance;
  readonly httpAgent?: http.Agent;
  readonly httpsAgent?: https.Agent;
}

export class AxiosHttpTransport implements HttpTransport {
  private readonly client: AxiosInstance;

  constructor(options: AxiosHttpTransportOptions = {}) {
    this.client =
      options.axiosInstance ??
      axios.create({
        httpAgent: options.httpAgent ?? defaultHttpAgent,
        httpsAgent: options.httpsAgent ?? defaultHttpsAgent,
      });
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    validateRequest(request);

    if (request.signal?.aborted === true) {
      throw new HttpTransportError({
        code: "REQUEST_ABORTED",
        message: "HTTP request was aborted.",
        retryable: false,
      });
    }

    const config: AxiosRequestConfig = {
      method: request.method,
      url: request.url,
      timeout: request.timeoutMs,
      proxy: false,
      maxRedirects: 0,
      validateStatus: () => true,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.params === undefined ? {} : { params: request.params }),
      ...(request.body === undefined ? {} : { data: request.body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };

    try {
      const response = await this.client.request(config);
      return {
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: response.data,
      };
    } catch (error: unknown) {
      if (error instanceof HttpTransportError) {
        throw error;
      }
      throw normalizeAxiosError(error, request);
    }
  }
}

export function normalizeAxiosError(
  error: unknown,
  request: HttpRequest,
): HttpTransportError {
  const message = isAxiosError(error) ? error.message : error instanceof Error ? error.message : "Unknown HTTP failure.";
  const code = isAxiosError(error) ? error.code : undefined;
  const status = isAxiosError(error) ? error.response?.status ?? null : null;

  if (request.signal?.aborted === true || code === "ERR_CANCELED") {
    return new HttpTransportError({
      code: "REQUEST_ABORTED",
      message: "HTTP request was aborted.",
      retryable: false,
      status,
      cause: { code: "ERR_CANCELED" },
    });
  }

  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(message)) {
    return new HttpTransportError({
      code: "REQUEST_TIMEOUT",
      message: "HTTP request timed out.",
      retryable: true,
      status,
      cause: { code: code ?? "ETIMEDOUT" },
    });
  }

  return new HttpTransportError({
    code: "NETWORK_ERROR",
    message: "HTTP request failed at the network boundary.",
    retryable: true,
    status,
    cause: { name: isAxiosError(error) ? "AxiosError" : "Error", code: code ?? "UNKNOWN" },
  });
}

function validateRequest(request: HttpRequest): void {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    throw new HttpTransportError({
      code: "INVALID_REQUEST",
      message: "HTTP request URL must be valid.",
      retryable: false,
    });
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new HttpTransportError({
      code: "INVALID_REQUEST",
      message: "HTTP request URL must use HTTP(S) without userinfo.",
      retryable: false,
    });
  }

  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 86_400_000) {
    throw new HttpTransportError({
      code: "INVALID_REQUEST",
      message: "HTTP request timeout must be a positive bounded integer.",
      retryable: false,
    });
  }

  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new HttpTransportError({
        code: "INVALID_REQUEST",
        message: "HTTP request headers must not contain line breaks.",
        retryable: false,
      });
    }
  }
}

function normalizeHeaders(headers: unknown): Record<string, string | readonly string[]> {
  const result: Record<string, string | readonly string[]> = {};
  if (headers === null || typeof headers !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[key] = value.map((entry) => String(entry));
    } else if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
}
