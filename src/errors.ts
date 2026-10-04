/** Every failure the SDK raises, with the API's error code preserved. */
export class GitloomError extends Error {
  readonly code: string
  readonly status: number
  /** Seconds to wait, when a 429 said so in `Retry-After`. Nothing retries on its own. */
  declare readonly retryAfter?: number

  constructor(
    code: string,
    message: string,
    status: number,
    options?: { cause?: unknown; retryAfter?: number | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GitloomError'
    this.code = code
    this.status = status
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter
  }

  /**
   * Whether trying again could plausibly succeed.
   *
   * 429 is deliberately NOT retryable. A monthly quota refusal will not clear
   * in a few hundred milliseconds, so retrying turns one refusal into three
   * requests — and on a metered API, three charges. A rate limit that carried
   * Retry-After would be a different case; this one does not.
   */
  get retryable(): boolean {
    return this.status >= 500
  }

  /** The namespace named in the request does not exist. Create it first. */
  get isNamespaceNotFound(): boolean {
    return this.code === 'namespace_not_found'
  }

  /** The account has used its plan's monthly allowance. */
  get isQuotaExceeded(): boolean {
    return this.code === 'quota_exceeded'
  }

  /** Too many requests in a short window. Unlike the quota, it clears on its own. */
  get isRateLimited(): boolean {
    return this.code === 'rate_limited'
  }

  /** The prepaid wallet is empty. */
  get isBalanceExhausted(): boolean {
    return this.code === 'balance_exhausted'
  }
}

const MAX_MESSAGE = 300

/**
 * The API answers `{"error":{"code","message"}}`. The gateway in front of it
 * does not: a missing or bad key gets a bare `{"message":…}`, an older route
 * a flat `{"error":"…"}`, and a proxy text, or JSON that is not an object.
 */
export async function errorFromResponse(res: Response, secret: string): Promise<GitloomError> {
  const text = redact((await res.text().catch(() => '')).trim(), secret)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const obj = isObject(body) ? body : undefined
  const retry = retryAfter(res)

  if (isObject(obj?.error)) {
    const { code, message } = obj.error
    return new GitloomError(
      typeof code === 'string' && code ? code : `http_${res.status}`,
      typeof message === 'string' && message ? message : statusText(res),
      res.status,
      { retryAfter: retry },
    )
  }
  if (typeof obj?.error === 'string' && obj.error) {
    return new GitloomError(`http_${res.status}`, obj.error, res.status, { retryAfter: retry })
  }
  if (res.status === 403) {
    return new GitloomError(
      'unauthorized',
      'The API key was not accepted (403 Forbidden) — check the API key (GITLOOM_API_KEY, or the key passed to the client), or whether it has been revoked.',
      403,
    )
  }
  if (res.status === 401) {
    return new GitloomError(
      'unauthorized',
      'No API key was accepted (401 Unauthorized) — check the API key (GITLOOM_API_KEY, or the key passed to the client).',
      401,
    )
  }
  let message = statusText(res)
  if (typeof obj?.message === 'string' && obj.message) message = obj.message
  else if (text && body !== null) message = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
  return new GitloomError(`http_${res.status}`, message, res.status, { retryAfter: retry })
}

/** The key never reaches an error, even when a proxy echoes the request back. */
export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

/**
 * A transport failure's cause chain as plain errors: name, code and message
 * kept, anything a fetch stored on it, such as the request and its headers, not.
 */
export function scrubbed(e: unknown, secret: string, depth = 0): Error {
  const src = (typeof e === 'object' && e !== null ? e : {}) as {
    name?: unknown
    message?: unknown
    code?: unknown
    cause?: unknown
  }
  const out = new Error(redact(String(src.message ?? e), secret)) as Error & { code?: string }
  if (typeof src.name === 'string') out.name = src.name
  if (typeof src.code === 'string') out.code = src.code
  if (src.cause !== undefined && depth < 4) out.cause = scrubbed(src.cause, secret, depth + 1)
  return out
}

/** Integer seconds from a 429's `Retry-After`; an HTTP date or anything else is ignored. */
function retryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after')?.trim()
  return res.status === 429 && v && /^\d+$/.test(v) ? Number(v) : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function statusText(res: Response): string {
  return res.statusText || `Request failed with ${res.status}`
}
