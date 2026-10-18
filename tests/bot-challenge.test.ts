// Akamai Bot Manager interstitial handling: when the bridged browser's
// anti-bot clearance lapses, OpenTable answers every SSR GET with a ~3 KB
// HTTP 200 challenge page. It must surface as a BotChallengeError (and the
// `bot_challenge` capability code), never as a misleading parse failure.
import { describe, it, expect } from 'vitest';
import { BotChallengeError, OpenTableClient, readFailureCode } from '../src/client.js';
import { ParseError } from '../src/initial-state.js';
import { parseAvailabilityResponse } from '../src/parse-slots.js';
import { registerSearchTools } from '../src/tools/search.js';
import type { OpenTableTransport } from '../src/transport.js';
import { createTestHarness } from './helpers.js';

// Synthetic reduction of the live 2026-10-18 interstitial (script path scrubbed).
const CHALLENGE_HTML = `<!DOCTYPE html>
<html>
<body><script type="text/javascript" src="/synthetic/challenge-script?v=00000000-0000-0000-0000-000000000000&amp;t=1"></script>
<div id="sec-if-cpt-container" role="main" style="display: none">
    <div class="behavioral-content">
        <div class="sec-text-container">Checking your browser…</div>
    </div>
</div>
</body>
</html>`;

function clientReturning(body: string): OpenTableClient {
  const transport = {
    start: async () => {},
    close: async () => {},
    fetch: async () => ({ status: 200, body, url: 'https://www.opentable.com/r/some-place' }),
    graphqlQuery: async () => ({}),
  } as unknown as OpenTableTransport;
  return new OpenTableClient({ transport });
}

describe('bot challenge detection', () => {
  it('fetchHtml throws BotChallengeError on the challenge interstitial', async () => {
    const client = clientReturning(CHALLENGE_HTML);
    const error = await client.fetchHtml('/r/some-place').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotChallengeError);
    expect((error as Error).message).toMatch(/blocked by a bot check/);
    expect((error as Error).message).toMatch(/not an empty result/);
    expect((error as Error).message).not.toMatch(/__INITIAL_STATE__/);
  });

  it('does not flag a full page that happens to contain a marker string', async () => {
    const real = `<html><script>{"__INITIAL_STATE__":{}}</script>${'x'.repeat(30_000)} behavioral-content</html>`;
    await expect(clientReturning(real).fetchHtml('/r/some-place')).resolves.toBe(real);
  });

  it('readFailureCode distinguishes a bot challenge from a parse error', () => {
    expect(readFailureCode(new BotChallengeError('/s'))).toBe('bot_challenge');
    expect(readFailureCode(new ParseError('x'))).toBe('read_or_parse_error');
  });

  it('search reports the challenge and records the bot_challenge capability', async () => {
    const client = clientReturning(CHALLENGE_HTML);
    const harness = await createTestHarness((server) => registerSearchTools(server, client));
    try {
      const reply = await harness.callTool('opentable_search_restaurants', { term: 'italian', location: 'New York' });
      expect(reply.isError).toBe(true);
      expect((reply.content[0] as { text: string }).text).toMatch(/blocked by a bot check/);
      expect(client.capabilityStatus().search).toMatchObject({ state: 'failed', code: 'bot_challenge' });
    } finally {
      await harness.close();
    }
  });
});

describe('availability with null restaurant entries', () => {
  it('throws an explicit unverified-availability error instead of a null dereference', () => {
    expect(() => parseAvailabilityResponse({ data: { availability: [null] } }, '2026-10-20', '19:00', 2)).toThrow(
      /Availability is unverified, not empty/
    );
  });

  it('skips a null entry alongside real ones', () => {
    const mixed = {
      data: {
        availability: [
          null,
          {
            restaurantId: 7,
            availabilityDays: [
              { slots: [{ isAvailable: true, timeOffsetMinutes: 0, slotAvailabilityToken: 't', slotHash: 'h' }] },
            ],
          },
        ],
      },
    };
    const slots = parseAvailabilityResponse(mixed, '2026-10-20', '19:00', 2);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ restaurant_id: 7, time: '19:00' });
  });
});
