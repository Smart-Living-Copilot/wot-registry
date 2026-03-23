import { Blob } from 'node:buffer';

import axios from 'axios';

import { config } from '../config/env.js';
import { extractRegistryErrorMessage, registryServiceHeaders } from './thing-catalog-client.js';

/**
 * Represents a stored content entry in the central registry's content store.
 */
export type ContentStoreEntry = {
  content_ref: string;
  digest: string;
  content_type: string;
  size_bytes: number;
  filename: string;
  created_at: string;
  expires_at: string | null;
  ttl_seconds: number | null;
  source: string | null;
  metadata: Record<string, unknown>;
  preview: string;
  detail_url: string;
  download_url: string;
};

/**
 * Parameters for storing a new content blob.
 */
type StoreContentBlobParams = {
  payload: Buffer;
  contentType: string;
  filename?: string;
  ttlSeconds?: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Generates the full URL for the registry's content store API.
 */
function contentUrl(path = ''): string {
  const trimmed = path.replace(/^\/+/, '');
  if (!trimmed) {
    return `${config.registryUrl}/api/content`;
  }
  return `${config.registryUrl}/api/content/${trimmed}`;
}

/**
 * Fetches a content blob from the central registry by its reference.
 *
 * @param contentRef The unique reference string for the content.
 * @returns A promise resolving to the payload Buffer and its content type.
 * @throws {Error} if the fetch fails.
 */
export async function fetchContentBlob(contentRef: string): Promise<{ payload: Buffer; contentType: string }> {
  try {
    const response = await axios.get(contentUrl(`${encodeURIComponent(contentRef)}/download`), {
      headers: registryServiceHeaders(),
      timeout: config.requestTimeoutMs,
      responseType: 'arraybuffer',
    });
    const contentType =
      typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type']
        : 'application/octet-stream';
    return {
      payload: Buffer.from(response.data),
      contentType,
    };
  } catch (error) {
    throw new Error(extractRegistryErrorMessage(error, `Failed to fetch content ref '${contentRef}'`));
  }
}

/**
 * Stores a binary blob in the central registry's content store.
 * Used for offloading oversized WoT interaction payloads.
 *
 * @param params The content blob and associated metadata.
 * @returns A promise resolving to the created ContentStoreEntry.
 * @throws {Error} if the storage operation fails.
 */
export async function storeContentBlob(params: StoreContentBlobParams): Promise<ContentStoreEntry> {
  const normalizedContentType = params.contentType.trim() || 'application/octet-stream';
  const form = new FormData();

  form.set(
    'file',
    new Blob([params.payload], { type: normalizedContentType }),
    params.filename?.trim() || 'payload.bin',
  );

  if (typeof params.ttlSeconds === 'number' && params.ttlSeconds > 0) {
    form.set('ttl_seconds', String(Math.trunc(params.ttlSeconds)));
  }

  if (params.source?.trim()) {
    form.set('source', params.source.trim());
  }

  form.set('metadata_json', JSON.stringify(params.metadata || {}));

  try {
    const response = await axios.post<ContentStoreEntry>(contentUrl('blob'), form, {
      headers: registryServiceHeaders(),
      timeout: config.requestTimeoutMs,
    });
    return response.data;
  } catch (error) {
    throw new Error(extractRegistryErrorMessage(error, 'Failed to store oversized WoT payload'));
  }
}
