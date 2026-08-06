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

  /** The account is over its plan limit. */
  get isQuotaExceeded(): boolean {
    return this.code === 'quota_exceeded' || this.status === 429
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

export async function errorFromResponse(res: Response): Promise<GitloomError> {
  let code = `http_${res.status}`
  let message = res.statusText || `Request failed with ${res.status}`
  try {
    const body = (await res.json()) as ApiErrorBody
    if (body?.error?.code) code = body.error.code
    if (body?.error?.message) message = body.error.message
  } catch {
    // A gateway can answer with plain text, or nothing. The status still tells
    // the caller what happened, so a body that will not parse is not fatal.
  }
  if (res.status === 401) {
    message += ' — check GITLOOM_API_KEY, or whether the key has been revoked.'
  }
  return new GitloomError(code, message, res.status)
}
