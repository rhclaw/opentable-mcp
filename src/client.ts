// OpenTableClient is the thin, tool-facing API over an OpenTableTransport.
// Every tool goes through fetchHtml() (SSR pages) or fetchJson() (API
// endpoints). The transport — FetchproxyTransport (wraps
// @fetchproxy/server's FetchproxyServer) by default, or
// HTTP-to-hangwin/mcp-chrome when enabled — handles the actual
// round-trip to the user's Chrome.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it AND so it stays
// consistent across transports.
import {
  SessionNotAuthenticatedError,
  truncateErrorMessage,
  UpstreamHttpError,
} from '@chrischall/mcp-utils';
import type { FetchInit, FetchResult, OpenTableTransport } from './transport.js';

/**
 * Logical handle for the RestaurantsAvailability graphql operation,
 * shared between `transport-fetchproxy.ts` (which declares it in
 * `graphqlOps`) and `tools/reservations.ts` (which passes it to
 * `client.graphqlQuery`). Lives here — the one file tool implementations
 * are allowed to import from — rather than in a transport implementation,
 * so a nominally transport-agnostic tool file never has to reach into
 * `transport-fetchproxy.ts` directly.
 */
export const AVAILABILITY_GRAPHQL_OP_NAME = 'availability';

// Non-2xx responses throw the fleet-shared `UpstreamHttpError`
// (`@chrischall/mcp-utils`) — the status-carrying error the http kit exposes
// for manual throws. It carries the numeric `.status` so callers can branch
// (e.g. `opentable_get_restaurant` falls back from `/r/{slug}` to `/{slug}`
// on a 404), and the `message` is still the same `OpenTable API error: …`
// string, so existing string/regex assertions hold. Re-exported below for the
// existing `./client.js` import sites.
//
// Sign-in failures throw the canonical SessionNotAuthenticatedError from
// @chrischall/mcp-utils (re-exported below for existing import sites).
// NOTE: the message changed from the old local copy ("Open the pinned
// OpenTable tab…") to the fleet-wide canonical form ("Not signed in to
// OpenTable. Open opentable.com in your browser and sign in, then try
// again. …").
export { SessionNotAuthenticatedError, UpstreamHttpError };

/**
 * OpenTable's Akamai Bot Manager answers with a small HTTP 200 interstitial
 * (`<div id="sec-if-cpt-container">` + a challenge script) once the bridged
 * browser's anti-bot clearance lapses. The bridge's in-tab fetch() never runs
 * that script, so without this check every SSR tool reported the misleading
 * "__INITIAL_STATE__ not found" and agents retried or guessed slugs. Only a
 * real page load in the bridged browser renews the clearance.
 */
export class BotChallengeError extends Error {
  readonly code = 'bot_challenge';
  constructor(path: string) {
    super(
      `OpenTable is blocked by a bot check (anti-bot challenge page instead of ${path}). ` +
        'This is not an empty result and not a parsing change: the bridged browser\'s anti-bot clearance has expired. ' +
        'Do not retry other restaurants, guess URLs or use a booking preview. ' +
        'Report OpenTable as temporarily unavailable; recovery is to reload an OpenTable restaurant page in the bridged browser, after which one retry is reasonable.'
    );
    this.name = 'BotChallengeError';
  }
}

const BOT_CHALLENGE_MARKERS = ['sec-if-cpt-container', 'behavioral-content'];

/** Capability-observation code for a failed SSR read. */
export function readFailureCode(error: unknown): string {
  return error instanceof BotChallengeError ? error.code : 'read_or_parse_error';
}

export interface OpenTableClientOptions {
  /** Transport used to relay fetches to the user's browser. Required —
   *  no implicit default since the migration to @fetchproxy/server. */
  transport: OpenTableTransport;
}

export class OpenTableClient {
  private readonly transport: OpenTableTransport;
  private readonly observations: Partial<Record<'search' | 'menus' | 'availability', { state: 'passed' | 'failed'; observed_at: string; code?: string }>> = {};

  recordCapability(name: 'search' | 'menus' | 'availability', state: 'passed' | 'failed', code?: string): void {
    this.observations[name] = { state, observed_at: new Date().toISOString(), ...(code ? { code } : {}) };
  }

  capabilityStatus(): Record<string, { state: string; observed_at?: string; code?: string; fresh?: boolean }> {
    const result: Record<string, { state: string; observed_at?: string; code?: string; fresh?: boolean }> = {};
    for (const name of ['search', 'menus', 'availability'] as const) {
      const observed = this.observations[name];
      result[name] = observed ? { ...observed, fresh: Date.now() - Date.parse(observed.observed_at) < 300_000 } : { state: 'not_probed' };
    }
    result.booking = { state: 'not_probed' }; // A read-only healthcheck never holds or books inventory.
    return result;
  }

  constructor(opts: OpenTableClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * GET an opentable.com path, return the HTML body. Throws if the response
   * is a non-2xx or appears to be the sign-in page.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfBotChallenge(result, path);
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * POST/DELETE a JSON body, return the parsed JSON response. Throws on
   * non-2xx, invalid JSON, or sign-in page.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'POST' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<T> {
    const serialised: FetchInit = {
      path,
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    };
    const result = await this.transport.fetch(serialised);
    this.throwIfNotOk(result, serialised.method, path);
    this.throwIfSignInPage(result);
    // 204 No Content (common on void mutations like /dapi/wishlist/add): return null.
    if (result.status === 204 || result.body === '') {
      return null as T;
    }
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `OpenTable ${serialised.method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
  }

  /**
   * Invoke a declared GraphQL operation through the transport's `graphql`
   * capability (fetchproxy: routes through the tab's own Apollo client
   * rather than the isolated-world fetch() path). Resolves to the
   * GraphQL response's `data` object. Unlike fetchHtml/fetchJson there's
   * no HTTP status or sign-in-page concept here — the transport throws
   * directly on any bridge- or GraphQL-level failure, including the
   * expected "operation not yet observed on this tab" case when no page
   * has triggered the operation yet in this session.
   */
  async graphqlQuery(name: string, variables: Record<string, unknown>): Promise<unknown> {
    try {
      const data = await this.transport.graphqlQuery({ name, variables });
      if (name === AVAILABILITY_GRAPHQL_OP_NAME) this.recordCapability('availability', 'passed');
      return data;
    } catch (error) {
      if (name !== AVAILABILITY_GRAPHQL_OP_NAME) throw error;
      const message = truncateErrorMessage(error instanceof Error ? error.message : String(error));
      const status = message.match(/(?:status(?: code)?|HTTP)\s*[:=]?\s*(403|409)\b/i)?.[1];
      this.recordCapability('availability', 'failed', status ? `http_${status}` : 'graphql_error');
      throw new Error(`${message}. Availability is unverified, not empty. A successful robots/bridge probe does not test this operation. Open or refresh an OpenTable restaurant page in the signed-in bridged browser, allow its availability query to load, complete any visible sign-in/human challenge, then retry once. Do not cycle through other restaurants or use a booking preview as a probe.`, { cause: error });
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    // Include the response body (collapsed + trimmed) — OpenTable's 4xx bodies
    // usually name the missing/invalid field, which is essential for debugging
    // write tools. truncateErrorMessage (mcp-utils) redacts any bearer/JWT
    // secrets and caps the length at the fleet-wide 500-char budget; we collapse
    // internal whitespace first so multi-line HTML error pages stay one line.
    const collapsed = result.body.replace(/\s+/g, ' ').trim();
    const bodyPreview = collapsed ? ` — ${truncateErrorMessage(collapsed)}` : '';
    throw new UpstreamHttpError(
      result.status,
      `OpenTable API error: ${result.status} for ${method} ${path}${bodyPreview}`
    );
  }

  private throwIfBotChallenge(result: FetchResult, path: string): void {
    // Real OpenTable pages are hundreds of KB; the interstitial is ~3 KB.
    if (result.body.length < 20_000 && BOT_CHALLENGE_MARKERS.some((m) => result.body.includes(m))) {
      throw new BotChallengeError(path);
    }
  }

  private throwIfSignInPage(result: FetchResult): void {
    const signInMarkers = [
      '/authenticate/start',
      'continue-with-email-button',
      'header-sign-in-button',
    ];
    const looksLikeSignIn =
      result.url.includes('/authenticate/') ||
      signInMarkers.some((m) => result.body.includes(m) && result.body.length < 80_000);
    if (looksLikeSignIn) {
      throw new SessionNotAuthenticatedError('OpenTable', 'opentable.com');
    }
  }
}
