import { z } from 'zod';
import { PositiveInt, minifiedResult } from '@chrischall/mcp-utils';
import { viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { readFailureCode, type OpenTableClient } from '../client.js';
import { parseSearch } from '../parse-search.js';

/**
 * Build the OpenTable search URL the way the web app does.
 *
 * OpenTable's /s?... endpoint is SSR-rendered; the backend resolves a
 * free-text term into a metro via an `intentModifiedTerm` parameter and
 * populates the lat/lng / metroId internally. We only need to pass the
 * required bits (term, covers, dateTime) and OpenTable does the rest.
 */
function buildSearchUrl(opts: {
  term?: string;
  location?: string;
  date?: string;
  time?: string;
  party_size?: number;
  latitude?: number;
  longitude?: number;
  metro_id?: number;
}): string {
  const params = new URLSearchParams();
  const term = [opts.term, opts.location].filter(Boolean).join(' ').trim();
  if (term) params.set('term', term);
  if (opts.party_size !== undefined) params.set('covers', String(opts.party_size));
  if (opts.date) {
    const dt = opts.time ? `${opts.date}T${opts.time}` : `${opts.date}T19:00`;
    params.set('dateTime', dt);
  }
  if (opts.latitude !== undefined) params.set('latitude', String(opts.latitude));
  if (opts.longitude !== undefined) params.set('longitude', String(opts.longitude));
  if (opts.metro_id !== undefined) params.set('metroId', String(opts.metro_id));
  const qs = params.toString();
  return `/s${qs ? `?${qs}` : ''}`;
}

export function registerSearchTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_search_restaurants',
    {
      description:
        'Search OpenTable for restaurants. Returns matching restaurants with cuisine, neighborhood, price band, rating, description, and URL. Does NOT include bookable slot tokens — use opentable_find_slots for a specific venue to check availability.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewArg(),
        term: z.string().optional().describe('Free-text query (cuisine or restaurant name)'),
        location: z
          .string()
          .optional()
          .describe('City / neighborhood / address — appended to the term. Prefer lat/lng when precise.'),
        date: z.string().optional().describe('YYYY-MM-DD. Affects search ranking but not returned slots.'),
        time: z.string().optional().describe('HH:MM (24h). Default 19:00 when date is set.'),
        party_size: PositiveInt.optional().describe('Number of guests. Default 2.'),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        metro_id: z.number().int().optional().describe('OpenTable metro id (e.g. 8 = SF Bay Area, 31 = Charlotte).'),
      }),
    },
    // `view` is destructured OFF the input before anything else sees it. It is a
    // response-shape knob, not a search parameter, and `buildSearchUrl` takes the
    // rest object — so a future field added to the schema reaches the URL builder
    // while `view` structurally cannot. (The earlier `input as { view?: string }`
    // cast left `view` sitting in the object handed to buildSearchUrl; that
    // builder enumerates its keys so nothing leaked, but the next one might not.)
    async ({ view, ...input }) => {
      try {
      const path = buildSearchUrl(input);
      const html = await client.fetchHtml(path);
      const result = parseSearch(html);
      client.recordCapability?.('search', 'passed');
      return viewResponse(view, result);
      } catch (error) { client.recordCapability?.('search', 'failed', readFailureCode(error)); throw error; }
    }
  );
}
