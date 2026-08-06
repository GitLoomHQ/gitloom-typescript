/**
 * Conversation attachments.
 *
 * Bytes go to GitLoom once, at append time; messages carry an id. The read
 * side answers with a short-lived URL rather than the bytes, so fetching an
 * image is a direct S3 read and never transits the API.
 */

import type { Gitloom } from './client'
import type { ContentPart } from './tokens'

export interface MediaInfo {
  id: string
  content_type: string
  bytes: number
  created_at: string
}

export interface MediaWithURL extends MediaInfo {
  /** Presigned; valid for url_expires_in_seconds from the moment of the call. */
  url: string
  url_expires_in_seconds: number
}

export class Media {
  constructor(private readonly client: Gitloom) {}

  /**
   * Store one attachment. Accepts base64 or raw bytes; 10MB cap; images,
   * audio, PDF, plain text and JSON.
   */
  async upload(input: { contentType: string; base64?: string; bytes?: Uint8Array }): Promise<MediaInfo> {
    let data = input.base64
    if (!data) {
      if (!input.bytes) throw new Error('media.upload needs base64 or bytes')
      data = toBase64(input.bytes)
    }
    return this.client.request<MediaInfo>('POST', '/v1/media', {
      content_type: input.contentType,
      data,
    })
  }

  /** The attachment's description plus a time-limited URL for its bytes. */
  async get(id: string): Promise<MediaWithURL> {
    return this.client.request<MediaWithURL>('GET', `/v1/media/${encodeURIComponent(id)}`)
  }
}

/** A text block. */
export function textPart(text: string): ContentPart {
  return { type: 'text', text }
}

/** An image block referencing an uploaded attachment. */
export function imagePart(mediaId: string): ContentPart {
  return { type: 'image', media_id: mediaId }
}

/**
 * An image block carrying bytes, uploaded transparently when the message is
 * appended — the part the model replayed later references the stored copy.
 */
export function imageData(base64: string, mediaType: string): ContentPart {
  return { type: 'image', data: { base64, media_type: mediaType } }
}

function toBase64(bytes: Uint8Array): string {
  // btoa exists in every runtime this SDK supports (Node 18+, browsers, edge);
  // chunked so a 10MB attachment does not blow the argument limit.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
