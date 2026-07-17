import type { ServerResponse } from 'node:http';
import {
  mockAbility,
  STANDARD_ABILITIES,
} from '../../src/__tests__/process/fixtures/api-responses.js';
import type {
  MockServer,
  RecordedRequest,
} from '../../src/__tests__/process/fixtures/mock-server.js';

export const FIXTURE_USERNAME = 'fake-user';
export const FIXTURE_APP_PASSWORD = 'clearly-fake fixture app password 1234';
export const FIXTURE_SITE_ID = 101;

interface FixturePlugin {
  slug: string;
  name: string;
  version: string;
  active: boolean;
  update_version: string | null;
}

interface FixtureSite {
  id: number;
  url: string;
  name: string;
  status: string;
  last_sync: string;
  plugins: FixturePlugin[];
}

export const FIXTURE_SITES: FixtureSite[] = [
  {
    id: FIXTURE_SITE_ID,
    url: 'https://alpha.example.invalid',
    name: 'Synthetic Alpha Site',
    status: 'connected',
    last_sync: '2026-01-01T00:00:00.000Z',
    plugins: [
      {
        slug: 'hello.php',
        name: 'Synthetic Hello Dolly',
        version: '1.0.0-fake',
        active: true,
        update_version: null,
      },
      {
        slug: 'example-cache/example-cache.php',
        name: 'Synthetic Example Cache',
        version: '2.0.0-fake',
        active: false,
        update_version: '2.1.0-fake',
      },
    ],
  },
  {
    id: 202,
    url: 'https://bravo.example.invalid',
    name: 'Synthetic Bravo Site',
    status: 'connected',
    last_sync: '2026-01-02T00:00:00.000Z',
    plugins: [],
  },
];

const countSitesAbility = mockAbility({
  name: 'mainwp/count-sites-v1',
  readonly: true,
  category: 'sites',
  input_schema: {
    type: 'object',
    properties: {
      tag_ids: { type: 'array', items: { type: 'integer' } },
    },
  },
});

export const FIXTURE_ABILITIES = [
  ...STANDARD_ABILITIES,
  countSitesAbility,
];

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function requestInput(request: RecordedRequest): Record<string, unknown> {
  if (request.method === 'GET' || request.method === 'DELETE') {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.query)) {
      const match = key.match(/^input\[([^\]]+)\](?:\[(?:\d*)\])?$/);
      if (!match?.[1]) continue;
      const inputKey = match[1];
      const parsed = /^-?\d+$/.test(value)
        ? Number(value)
        : value === 'true'
          ? true
          : value === 'false'
            ? false
            : value;
      if (/\[(?:\d*)\]$/.test(key)) {
        const current = input[inputKey];
        input[inputKey] = Array.isArray(current) ? [...current, parsed] : [parsed];
      } else {
        input[inputKey] = parsed;
      }
    }
    return input;
  }
  const body = request.body as Record<string, unknown> | undefined;
  const input = body?.['input'];
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function publicSite(site: FixtureSite): Omit<FixtureSite, 'plugins'> {
  const { plugins: _plugins, ...publicData } = site;
  return publicData;
}

function findSite(identifier: unknown): FixtureSite | undefined {
  const normalized = String(identifier ?? '').replace(/\/+$/, '').toLowerCase();
  return FIXTURE_SITES.find(site => {
    const url = site.url.replace(/\/+$/, '').toLowerCase();
    return String(site.id) === normalized ||
      url === normalized ||
      new URL(url).hostname === normalized;
  });
}

export function programFixtureServer(
  server: MockServer,
  options: { previewFailure?: boolean } = {},
): void {
  server.reset();
  server.setCredentials(FIXTURE_USERNAME, FIXTURE_APP_PASSWORD);
  server.setAbilities(FIXTURE_ABILITIES);

  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/list-sites-v1/run',
    (request, response) => {
      const input = requestInput(request);
      const page = typeof input['page'] === 'number' ? input['page'] : 1;
      const perPage = typeof input['per_page'] === 'number' ? input['per_page'] : 20;
      const start = (page - 1) * perPage;
      json(response, 200, {
        items: FIXTURE_SITES.slice(start, start + perPage).map(publicSite),
        page,
        per_page: perPage,
        total: FIXTURE_SITES.length,
      });
    },
  );

  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/count-sites-v1/run',
    (_request, response) => json(response, 200, { total: FIXTURE_SITES.length }),
  );

  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/get-site-v1/run',
    (request, response) => {
      const site = findSite(requestInput(request)['site_id_or_domain']);
      if (!site) {
        json(response, 404, {
          code: 'mainwp_site_not_found',
          message: 'The requested synthetic site was not found.',
          data: { status: 404 },
        });
        return;
      }
      json(response, 200, publicSite(site));
    },
  );

  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/get-site-plugins-v1/run',
    (request, response) => {
      const site = findSite(requestInput(request)['site_id_or_domain']);
      if (!site) {
        json(response, 404, {
          code: 'mainwp_site_not_found',
          message: 'The requested synthetic site was not found.',
          data: { status: 404 },
        });
        return;
      }
      json(response, 200, {
        site_id: site.id,
        site_url: site.url,
        plugins: site.plugins,
        total: site.plugins.length,
      });
    },
  );

  server.addRoute(
    'POST',
    '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run',
    (request, response) => {
      const input = requestInput(request);
      if (input['dry_run'] === true) {
        if (options.previewFailure) {
          json(response, 500, {
            code: 'fixture_preview_failed',
            message: 'Synthetic preview failure.',
          });
          return;
        }
        json(response, 200, {
          success: true,
          data: {
            affected: [{ site_id: FIXTURE_SITE_ID, name: 'Synthetic Alpha Site' }],
          },
        });
        return;
      }
      json(response, 200, { success: true, data: { deleted: true } });
    },
  );
}
