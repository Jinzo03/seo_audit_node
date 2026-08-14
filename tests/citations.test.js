const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchAiOverview,
  withSerpApiKey,
  checkCitations,
  extractCitationLinksFromAiOverview,
} = require('../src/geo/citations');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  };
}

describe('SerpApi citation checks', () => {
  test('withSerpApiKey injects the configured key into a provided follow-up URL', () => {
    const url = withSerpApiKey(
      'https://serpapi.com/search.json?engine=google_ai_overview&page_token=token-123',
      'real-key',
    );
    assert.equal(new URL(url).searchParams.get('api_key'), 'real-key');
  });

  test('withSerpApiKey replaces a stale key in a provided follow-up URL', () => {
    const url = withSerpApiKey(
      'https://serpapi.com/search.json?engine=google_ai_overview&page_token=token-123&api_key=stale-key',
      'real-key',
    );
    assert.equal(new URL(url).searchParams.get('api_key'), 'real-key');
  });

  test('fetchAiOverview requests only the AI Overview block', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = null;
    global.fetch = async (url) => {
      requestedUrl = new URL(url);
      return jsonResponse(200, { ai_overview: { text_blocks: [] } });
    };

    try {
      await fetchAiOverview('test query', 'test-key');
      assert.equal(requestedUrl.searchParams.get('engine'), 'google');
      assert.equal(requestedUrl.searchParams.get('json_restrictor'), 'ai_overview');
      assert.equal(requestedUrl.searchParams.get('no_cache'), 'true');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('checkCitations surfaces SerpApi error messages instead of hiding them', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => jsonResponse(401, { error: 'Invalid API key' });

    try {
      const [result] = await checkCitations(['test query'], 'example.com', 'bad-key', { delayMs: 0 });
      assert.equal(result.cited, false);
      assert.match(result.error, /Invalid API key/);
      assert.match(result.error, /401/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('fetchAiOverview follows a page_token response', async () => {
    const originalFetch = global.fetch;
    const requested = [];
    global.fetch = async (url) => {
      requested.push(new URL(url));
      if (requested.length === 1) {
        return jsonResponse(200, {
          ai_overview: {
            page_token: 'token-123',
            serpapi_link: 'https://serpapi.com/search.json?engine=google_ai_overview&page_token=token-123',
          },
        });
      }
      return jsonResponse(200, { ai_overview: { references: [{ link: 'https://example.com/source' }] } });
    };

    try {
      const overview = await fetchAiOverview('test query', 'test-key');
      assert.equal(requested.length, 2);
      assert.equal(requested[1].searchParams.get('engine'), 'google_ai_overview');
      assert.equal(requested[1].searchParams.get('api_key'), 'test-key');
      assert.deepEqual(extractCitationLinksFromAiOverview(overview), ['https://example.com/source']);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
