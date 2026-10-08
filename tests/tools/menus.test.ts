import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UpstreamHttpError } from '@chrischall/mcp-utils';
import type { OpenTableClient } from '../../src/client.js';
import { registerRestaurantTools } from '../../src/tools/restaurants.js';
import { createTestHarness } from '../helpers.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/restaurant-menus-state.json', import.meta.url), 'utf8'));
const html = `<script>${JSON.stringify({ windowVariables: { __INITIAL_STATE__: fixture } })}</script>`;
const mockFetchHtml = vi.fn();
const client = { fetchHtml: mockFetchHtml } as unknown as OpenTableClient;
let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });
const parse = (result: Awaited<ReturnType<typeof harness.callTool>>) => JSON.parse((result.content[0] as { text: string }).text);

describe('menu tool', () => {
  it('registers a read-only menu tool', async () => {
    harness = await createTestHarness(server => registerRestaurantTools(server, client));
    const { tools } = await harness.client.listTools();
    expect(tools.find(t => t.name === 'opentable_get_menu')?.annotations?.readOnlyHint).toBe(true);
  });

  it.each([42, '42'])('uses the numeric profile route for %s', async (restaurant_id) => {
    mockFetchHtml.mockResolvedValue(html);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id });
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml).toHaveBeenCalledExactlyOnceWith('/restaurant/profile/42');
    expect(parse(result)).toMatchObject({ url: 'https://www.opentable.com/restaurant/profile/42', available_menus: ['Breakfast', 'Dinner'] });
  });

  it('uses the exact URL path and filters the requested menu', async () => {
    mockFetchHtml.mockResolvedValue(html);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 'https://www.opentable.com/r/fixture-cafe', menu_name: ' dinner ' });
    expect(mockFetchHtml).toHaveBeenCalledExactlyOnceWith('/r/fixture-cafe');
    expect(parse(result).menus).toHaveLength(1);
    expect(parse(result).menus[0].title).toBe('Dinner');
  });

  it('falls back to a legacy root slug only after a 404', async () => {
    mockFetchHtml.mockRejectedValueOnce(new UpstreamHttpError(404, 'not found')).mockResolvedValueOnce(html);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 'fixture-cafe' });
    expect(mockFetchHtml.mock.calls).toEqual([['/r/fixture-cafe'], ['/fixture-cafe']]);
    expect(parse(result).url).toBe('https://www.opentable.com/fixture-cafe');
  });

  it('honors compact/full views without removing prices, descriptions, or menu links', async () => {
    mockFetchHtml.mockResolvedValue(html);
    for (const view of [undefined, 'full']) {
      const result = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42, menu_name: 'Dinner', ...(view ? { view } : {}) }));
      expect(result.menu_url).toBe('https://example.com/menu');
      expect(result.menus[0].sections).toEqual(fixture.restaurantProfile.menus.menuData[1].sections);
      expect(result.menus[0].description).toBe(fixture.restaurantProfile.menus.menuData[1].description);
      if (view === 'full') expect(result.menus[0].provider.image.url).toBe('https://example.com/provider.png');
      else expect(result.menus[0].provider.image?.url).toBeUndefined();
    }
  });

  it.each([new UpstreamHttpError(403, 'blocked'), new Error('session_not_ready')])('surfaces bridge/HTTP errors without retrying', async error => {
    mockFetchHtml.mockRejectedValue(error);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 'fixture-cafe' });
    expect(result.isError).toBe(true);
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
  });

  it('surfaces parsing failures without returning a successful empty menu', async () => {
    mockFetchHtml.mockResolvedValue('<html>Verify you are human</html>');
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 42 });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('__INITIAL_STATE__');
  });

  it('never fetches an external menu URL', async () => {
    const state = { restaurantProfile: { restaurant: {}, menus: { menuInfo: { url: 'https://example.com/menu.pdf' } } } };
    mockFetchHtml.mockResolvedValue(`<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`);
    const result = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42 }));
    expect(result.status).toBe('external_only');
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
  });
  it('returns whole paginated items under the native output cap', async () => {
    const state = structuredClone(fixture);
    state.restaurantProfile.menus.menuData[1].sections[0].items = Array.from({ length: 32 }, (_, i) => ({
      title: `Dish ${i}`, description: 'Full ingredients: chicken, rice and vegetables. '.repeat(6), price: '18.00',
      variationGroups: [{ items: [{ title: 'Large', price: '6.00' }] }],
    }));
    mockFetchHtml.mockResolvedValue(`<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`);
    const titles: string[] = [];
    let offset = 0;
    do {
      const response = await harness.callTool('opentable_get_menu', { restaurant_id: 42, menu_name: 'Dinner', offset });
      expect(response.isError).toBeFalsy();
      expect(JSON.stringify(response).length).toBeLessThan(10000);
      const page = parse(response);
      for (const section of page.menus[0].sections) for (const item of section.items) {
        titles.push(item.title);
        expect(item.description).toBe(state.restaurantProfile.menus.menuData[1].sections[0].items[0].description);
        expect(item.variationGroups[0].items[0].price).toBe('6.00');
      }
      expect(page.menus[0].updated).toBe(state.restaurantProfile.menus.menuData[1].updated);
      expect(page.pagination.total_items).toBe(32);
      offset = page.pagination.next_offset;
    } while (offset !== null);
    expect(titles).toEqual(Array.from({ length: 32 }, (_, i) => `Dish ${i}`));
  });

  it('honors small explicit pages and exact section filters', async () => {
    mockFetchHtml.mockResolvedValue(html);
    const page = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42, menu_name: 'Dinner', section_name: ' main courses ', limit: 1 }));
    expect(page.menus[0].sections[0].items).toHaveLength(1);
    expect(page.pagination.next_offset).toBe(1);
    expect(page.pagination.total_items).toBe(2);
    const missing = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42, section_name: 'Missing' }));
    expect(missing.section_found).toBe(false);
    expect(missing.available_sections).toContain('Main courses');
  });

  it('does not truncate a single oversized recipe or accept invalid paging', async () => {
    const state = structuredClone(fixture);
    state.restaurantProfile.menus.menuData[1].sections[0].items[0].description = 'ingredient '.repeat(2000);
    mockFetchHtml.mockResolvedValue(`<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`);
    expect((await harness.callTool('opentable_get_menu', { restaurant_id: 42, menu_name: 'Dinner' })).isError).toBe(true);
    expect((await harness.callTool('opentable_get_menu', { restaurant_id: 42, offset: -1 })).isError).toBe(true);
    const full = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42, menu_name: 'Dinner', view: 'full' }));
    expect(full.menus[0].sections[0].items[0].description).toBe('ingredient '.repeat(2000));
  });

});
