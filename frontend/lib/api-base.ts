// Where the backend API is, and how the dashboard server proves it is the caller. Server-side only: the browser never talks to the API.
export const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

/** When the API has INTERNAL_API_KEY set it answers only requests that carry it, so a public API address alone gets nobody in. */
export function apiHeaders(): Record<string, string> {
  const key = process.env.INTERNAL_API_KEY;
  return key ? { 'x-internal-key': key } : {};
}
