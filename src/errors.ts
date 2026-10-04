/** Every failure the SDK raises, with the API's error code preserved. */
export class GitloomError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'GitloomError'
    this.code = code
    this.status = status
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
 * does not: a missing or bad key gets a bare `{"message":…}`, and a proxy can
 * answer with text, or with JSON that is not an object.
 */
export async function errorFromResponse(res: Response): Promise<GitloomError> {
  const text = (await res.text().catch(() => '')).trim()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const obj = isObject(body) ? body : undefined

  if (isObject(obj?.error)) {
    const { code, message } = obj.error
    return new GitloomError(
      typeof code === 'string' && code ? code : `http_${res.status}`,
      typeof message === 'string' && message ? message : statusText(res),
      res.status,
    )
  }
  if (res.status === 403) {
    return new GitloomError(
      'unauthorized',
      'The API key was not accepted (403 Forbidden) — check GITLOOM_API_KEY, or whether the key has been revoked.',
      403,
    )
  }
  if (res.status === 401) {
    return new GitloomError(
      'unauthorized',
      'No API key was accepted (401 Unauthorized) — check GITLOOM_API_KEY.',
      401,
    )
  }
  let message = statusText(res)
  if (typeof obj?.message === 'string' && obj.message) message = obj.message
  else if (text) message = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
  return new GitloomError(`http_${res.status}`, message, res.status)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function statusText(res: Response): string {
  return res.statusText || `Request failed with ${res.status}`
}
