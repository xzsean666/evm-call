export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD";

export type HttpParameterValue = string | number | boolean | null | undefined;

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly params?: Readonly<Record<string, HttpParameterValue>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: unknown;
}

export type TransportErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED"
  | "NETWORK_ERROR";

export interface HttpTransportErrorOptions {
  readonly code: TransportErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number | null;
  readonly cause?: unknown;
}

export class HttpTransportError extends Error {
  readonly code: TransportErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  override readonly cause: unknown;

  constructor(options: HttpTransportErrorOptions) {
    if ("cause" in options) {
      super(options.message, { cause: options.cause });
    } else {
      super(options.message);
    }

    this.name = "HttpTransportError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export function isHttpTransportError(value: unknown): value is HttpTransportError {
  return value instanceof HttpTransportError;
}
