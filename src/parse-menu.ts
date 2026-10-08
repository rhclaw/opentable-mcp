import { extractInitialState, ParseError } from './initial-state.js';

export interface RestaurantMenus {
  restaurant_id: number | null;
  name: string;
  url: string;
  status: 'available' | 'external_only' | 'not_available' | 'menu_not_found';
  available_menus: string[];
  // Keep the observed menu payload intact: prices are strings, and variations,
  // currency, provider, updated timestamps and future fields are content.
  menus: Record<string, unknown>[];
  menu_url: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function menuUrl(value: unknown, sourceUrl: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, sourceUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Menus are a sibling of restaurantProfile.restaurant, not a field on it.
 * On 2026-10-06 SOCIAL's embedded application JSON carried all five menus
 * here, including Dinner, without clicking a menu tab or issuing another API
 * call. menuInfo.url can coexist with structured menus or be the only menu.
 */
export function parseMenu(
  html: string,
  sourceUrl: string,
  menuName?: string,
): RestaurantMenus {
  const state = extractInitialState(html);
  const profile = state.restaurantProfile;
  if (!isRecord(profile) || !isRecord(profile.restaurant)) {
    throw new ParseError('restaurantProfile.restaurant not present in __INITIAL_STATE__ (page may not be a restaurant profile)');
  }
  const container = profile.menus;
  if (container != null && !isRecord(container)) {
    throw new ParseError('restaurantProfile.menus is not an object');
  }
  const raw = container?.menuData;
  if (raw != null && (!Array.isArray(raw) || !raw.every(isRecord))) {
    throw new ParseError('restaurantProfile.menus.menuData is not an array of menu objects');
  }
  const menus: Record<string, unknown>[] = raw ?? [];
  const availableMenus = menus.map(menu => menu.title).filter((title): title is string => typeof title === 'string');
  const selected = menuName === undefined ? menus : menus.filter(menu =>
    typeof menu.title === 'string' && menu.title.trim().toLowerCase() === menuName.trim().toLowerCase(),
  );
  const info = container?.menuInfo;
  const externalUrl = menuUrl(isRecord(info) ? info.url : undefined, sourceUrl);
  const status = menus.length > 0
    ? selected.length > 0 ? 'available' : 'menu_not_found'
    : externalUrl ? 'external_only' : 'not_available';

  return {
    restaurant_id: typeof profile.restaurant.restaurantId === 'number' ? profile.restaurant.restaurantId : null,
    name: typeof profile.restaurant.name === 'string' ? profile.restaurant.name : 'Unknown',
    url: sourceUrl,
    status,
    available_menus: availableMenus,
    menus: selected,
    menu_url: externalUrl,
  };
}

/** Page whole items while preserving all observed recipe and menu metadata. */
export function pageMenu(result: RestaurantMenus, args: {
  view?: string; section_name?: string; offset?: number; limit?: number;
}): RestaurantMenus | Record<string, unknown> {
  const budget = 8500;
  if (args.view === 'full' && args.section_name === undefined && args.offset === undefined && args.limit === undefined) return result;
  if (args.section_name === undefined && args.offset === undefined && args.limit === undefined && JSON.stringify(result).length <= budget) return result;
  const offset = args.offset ?? 0;
  const available_sections: string[] = [];
  const entries: { menu: number; section: number; item: unknown }[] = [];
  const menus = result.menus.map((menu, mi) => {
    const sections = Array.isArray(menu.sections) ? menu.sections : [];
    const filtered = sections.filter(section => {
      if (!isRecord(section)) return true;
      if (typeof section.title === 'string') available_sections.push(section.title);
      return args.section_name === undefined || (typeof section.title === 'string' && section.title.trim().toLowerCase() === args.section_name.trim().toLowerCase());
    });
    return { ...menu, sections: filtered.map((section, si) => {
      if (!isRecord(section)) return section;
      if (Array.isArray(section.items)) for (const item of section.items) entries.push({ menu: mi, section: si, item });
      return { ...section, ...(Array.isArray(section.items) ? { items: [] } : {}) };
    }) };
  });
  let returned = Math.min(args.limit ?? 20, Math.max(0, entries.length - offset));
  const render = (count: number) => {
    const selected = structuredClone(menus);
    for (const entry of entries.slice(offset, offset + count)) {
      (selected[entry.menu].sections[entry.section] as Record<string, unknown> & { items: unknown[] }).items.push(entry.item);
    }
    return { ...result, menus: selected, available_sections: [...new Set(available_sections)],
      ...(args.section_name === undefined ? {} : { section_found: menus.some(menu => menu.sections.length > 0) }),
      pagination: { offset, returned_items: count, total_items: entries.length,
        next_offset: offset + count < entries.length ? offset + count : null },
      note: 'A page of whole published menu items; follow next_offset with the same menu/section selection. This is not live availability or kitchen confirmation.' };
  };
  let page = render(returned);
  while (JSON.stringify(page).length > budget && returned > 1) page = render(--returned);
  if (JSON.stringify(page).length > budget) throw new Error('A complete menu item or metadata exceeds the native response budget. Narrow menu_name/section_name or use view=full with an uncapped client; recipe text was not truncated.');
  return page;
}
