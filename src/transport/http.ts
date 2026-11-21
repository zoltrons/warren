// Thin fetch wrapper with the Bitwarden client headers. Runs in the service worker only.
import { CLIENT_NAME, CLIENT_VERSION, DEVICE_TYPE } from "../shared/constants.ts";
import { ci } from "../shared/validate.ts";

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  override name = "NetworkError";
}

interface CallOptions {
  json?: unknown;
  form?: Record<string, string>;
  /** multipart/form-data (file uploads); the browser sets the boundary header. */
  data?: FormData;
  token?: string;
  signal?: AbortSignal;
}

/**
 * Upper bound for a response body. A broken or hostile server must not be able to exhaust the service
 * worker's memory (or the worker's message budget) by answering with an endless stream. Generous: far above
 * any real vault's sync response.
 */
export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

/** How long a request may go without a byte arriving (headers or body) before it counts as lost. */
export const STALL_MS = 30_000;

const tooLarge = (what: string) => new ApiError(0, null, `The server's ${what} is too large`);

const netError = (e: unknown) => new NetworkError(e instanceof Error ? e.message : String(e));

/**
 * Aborts once nothing has arrived for `ms`: a dead server or link is given up on as quickly as a fixed timeout would,
 * but a large vault on a slow link is not cut off while its bytes still flow. `poke` marks progress.
 */
export function stallTimeout(ms: number): { signal: AbortSignal; poke: () => void; stop: () => void } {
  const c = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const poke = () => {
    stop();
    timer = setTimeout(() => c.abort(new DOMException("The server stopped answering", "TimeoutError")), ms);
  };
  poke();
  return { signal: c.signal, poke, stop };
}

/** Streams a body into memory, refusing anything over `max` bytes. A connection lost mid-body is a NetworkError. */
export async function readBytes(res: Response, max = MAX_RESPONSE_BYTES, what = "response", onChunk?: () => void): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooLarge(what);
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read().catch((e: unknown) => {
      throw netError(e);
    });
    if (done) break;
    onChunk?.();
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(what);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** First non-empty message. Vaultwarden's generic error sends `error_description: ""` next to the real `message`. */
export function errorMessage(body: unknown, status: number): string {
  const candidates = [
    ci(body, "error_description"),
    ci(ci(body, "ErrorModel"), "Message"),
    ci(body, "message"),
    ci(ci(body, "error"), "description"),
  ];
  // Cut: a hostile server must not flood the popup with an endless error text.
  // No text of the server's own (a proxy's error page): say what a 5xx usually means.
  const fallback = status >= 500 ? `The server answered with an error (HTTP ${status}). It may be down, starting or misconfigured.` : `HTTP ${status}`;
  return (candidates.find((m): m is string => typeof m === "string" && m.trim() !== "") ?? fallback).slice(0, 500);
}

export async function call(base: string, method: string, path: string, opts: CallOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Bitwarden-Client-Name": CLIENT_NAME,
    "Bitwarden-Client-Version": CLIENT_VERSION,
    "Device-Type": String(DEVICE_TYPE),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    body = new URLSearchParams(opts.form);
  } else if (opts.data) body = opts.data;
  // Uploads bring their own (total) timeout: fetch reports no upload progress to measure a stall by.
  const stall = opts.signal ? undefined : stallTimeout(STALL_MS);
  let res: Response;
  let bytes: Uint8Array;
  try {
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: opts.signal ?? stall!.signal,
      });
    } catch (e) {
      throw netError(e);
    }
    stall?.poke();
    bytes = await readBytes(res, MAX_RESPONSE_BYTES, "response", stall?.poke);
  } finally {
    stall?.stop();
  }
  const text = bytes.byteLength ? new TextDecoder().decode(bytes) : "";
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body (e.g. revision-date as plain number is still JSON) */
    }
  } else data = null;
  if (!res.ok) throw new ApiError(res.status, data, errorMessage(data, res.status));
  return data;
}
