import { createClient, D4ApiError, type D4Client } from '@d4/sdk';
import { userManager } from './auth';
import { config } from './config';

export { D4ApiError };
export type { Schemas } from '@d4/sdk';

/** The signed-in user's access token (empty when signed out). */
export async function accessToken(): Promise<string> {
  return (await userManager().getUser())?.access_token ?? '';
}

let client: D4Client | undefined;

/**
 * The typed API client (paths, parameters, bodies and results checked against the OpenAPI
 * document), signed in as the current user. Created on first use, after the runtime settings.
 */
export const d4 = (): D4Client => (client ??= createClient({ baseUrl: config.apiUrl, token: accessToken }));

/** Downloads a file response (exports, job artifacts): the body and the server's file name. */
export async function downloadFile(
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<{ blob: Blob; filename: string }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const res = await fetch(`${config.apiUrl}${path}${qs.size ? `?${qs.toString()}` : ''}`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      issues?: string[];
    };
    throw new D4ApiError(
      res.status,
      json.error ?? `HTTP_${res.status}`,
      json.message ?? res.statusText,
      json.issues ?? [],
    );
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
  return { blob: await res.blob(), filename: name };
}
