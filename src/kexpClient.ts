const KEXP_API_BASE_URL = 'https://api.kexp.org/v2/';

export type KexpQueryValue = string | number | boolean;

export interface KexpListRequest {
  endpoint: string;
  page?: number;
  limit?: number;
  query?: Record<string, KexpQueryValue>;
}

export interface KexpItemRequest {
  endpoint: string;
  id: string;
  query?: Record<string, KexpQueryValue>;
}

export function normalizeEndpoint(endpoint: string): string {
  const normalized = endpoint.trim().replace(/^\/+|\/+$/g, '');

  if (!normalized) {
    throw new Error('`endpoint` is required and cannot be empty.');
  }

  if (normalized.includes('..') || !/^[a-zA-Z0-9_/-]+$/.test(normalized)) {
    throw new Error('`endpoint` may only include letters, numbers, underscores, dashes, and forward slashes.');
  }

  return normalized;
}

function normalizeId(id: string): string {
  const normalized = id.trim();

  if (!normalized) {
    throw new Error('`id` is required and cannot be empty.');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error('`id` may only include letters, numbers, underscores, and dashes.');
  }

  return normalized;
}

export function buildKexpListUrl({ endpoint, page = 1, limit = 20, query = {} }: KexpListRequest): URL {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('`page` must be an integer greater than or equal to 1.');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('`limit` must be an integer between 1 and 100.');
  }

  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const url = new URL(`${normalizedEndpoint}/`, KEXP_API_BASE_URL);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

export function buildKexpItemUrl({ endpoint, id, query = {} }: KexpItemRequest): URL {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const normalizedId = normalizeId(id);
  const url = new URL(`${normalizedEndpoint}/${normalizedId}/`, KEXP_API_BASE_URL);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

export async function fetchKexpJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const responseText = await response.text();
    const message = responseText ? responseText.slice(0, 400) : response.statusText;
    throw new Error(`KEXP API request failed (${response.status} ${response.statusText}): ${message}`);
  }

  return response.json();
}
