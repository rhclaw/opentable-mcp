import { z } from 'zod';
import { PositiveInt, UpstreamHttpError } from '@chrischall/mcp-utils';
import { viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OpenTableClient } from '../client.js';
import { parseRestaurant } from '../parse-restaurant.js';
import { parseMenu, pageMenu } from '../parse-menu.js';
import { restaurantCandidatePaths, OPENTABLE_BASE_URL } from '../urls.js';

async function fetchRestaurantPage(client: OpenTableClient, restaurantId: string | number): Promise<{ html: string; url: string }> {
  const candidates = restaurantCandidatePaths(restaurantId);
  let lastNotFound: UpstreamHttpError | undefined;
  for (const path of candidates) {
    try {
      return { html: await client.fetchHtml(path), url: `${OPENTABLE_BASE_URL}${path}` };
    } catch (e) {
      if (e instanceof UpstreamHttpError && e.status === 404) {
        lastNotFound = e;
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `No OpenTable restaurant detail page found for "${restaurantId}" (tried ${candidates.join(', ')}). ` +
    `Pass the exact "url" from opentable_search_restaurants. Underlying error: ${lastNotFound?.message ?? 'not found'}`,
  );
}

export function registerRestaurantTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_get_restaurant',
    {
      description:
        'Get full details for a single OpenTable restaurant: cuisine, price band, description, address, hours, phone, payment options, features, rating/review count, and availability_token (used internally when booking). Accepts the numeric restaurant_id, a slug, a path, or the full URL from opentable_search_restaurants — passing the search result\'s "url" verbatim always resolves, including legacy venues served at /{slug} instead of /r/{slug}.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewArg(),
        restaurant_id: z
          .union([z.string(), PositiveInt])
          .describe(
            'Numeric restaurant_id (as returned by opentable_list_reservations / opentable_list_favorites), slug ("state-of-confusion-charlotte"), path, or full URL from opentable_search_restaurants. Passing the search result\'s "url" verbatim resolves both /r/{slug} and legacy /{slug} venues; a numeric id resolves via /restaurant/profile/{id}.'
          ),
      }),
    },
    async ({ restaurant_id, view }) => {
      const { html, url } = await fetchRestaurantPage(client, restaurant_id);
      return viewResponse(view, parseRestaurant(html, url));
    }
  );

  server.registerTool(
    'opentable_get_menu',
    {
      description:
        'Large menus return bounded pages of whole items; follow pagination.next_offset with the same filters. Optional section_name selects an exact section; offset/limit paginate items. view=full without paging is uncapped. Get published menus for an OpenTable restaurant, including sections, dishes, prices, variations, currency, provider and updated timestamps. Accepts the same numeric id/slug/path/URL as opentable_get_restaurant. Optional menu_name selects an exact title case-insensitively (e.g. Dinner). Returns available_menus and status: available, menu_not_found, external_only or not_available. External menu_url links are returned but never fetched. Prices describe OpenTable\'s published menu, not a live quote from the restaurant.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewArg(),
        restaurant_id: z.union([z.string(), PositiveInt]).describe('Numeric restaurant id, slug, path, or exact URL from opentable_search_restaurants.'),
        section_name: z.string().trim().min(1).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        menu_name: z.string().trim().min(1).optional().describe('Exact published menu title, case-insensitive. Omit to return all menus; available_menus lists titles when a selection is not found.'),
      }),
    },
    async ({ restaurant_id, menu_name, view, section_name, offset, limit }) => {
      try {
        const { html, url } = await fetchRestaurantPage(client, restaurant_id);
        const result = pageMenu(parseMenu(html, url, menu_name), { view, section_name, offset, limit });
        client.recordCapability?.('menus', 'passed');
        return viewResponse(view, result);
      } catch (error) { client.recordCapability?.('menus', 'failed', 'read_or_parse_error'); throw error; }

    },
  );
}
