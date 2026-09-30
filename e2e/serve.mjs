/*
 * serve.mjs — the `http://localhost` half of the protocol matrix (`09-testing.md` §4).
 *
 * REQ-SHELL-004 is the requirement that the application behaves the same over `file://` and over
 * HTTP, and the only way to check the second half is to actually serve it. This is a static file
 * server and nothing else: no routing, no rewriting, no MIME negotiation beyond what a browser needs
 * to render the artifact as HTML.
 *
 * It is deliberately not a dev dependency. The suite already depends on Node, and the alternative —
 * pulling in a server package — would put a network install between a clean checkout and the ability
 * to run the matrix at all, which is the property ADR-0009 exists to protect. (This file is test
 * tooling, so the no-dependency rule that binds `build.mjs` does not apply to it; the point is only
 * that nothing here needs installing.)
 *
 * `e2e/fixtures.mjs` starts it in the working directory the spec files care about (`dist/`), so a
 * spec never has to know the port — it asks for the URL.
 *
 * This directory is deliberately **not** `test/e2e/`. `node --test` with no path arguments imports
 * every `.mjs` under any directory named `test`, so a Playwright spec living there would be imported
 * outside its own runner and `@playwright/test` would abort the whole Node run with "Test did not
 * expect test() to be called here". `playwright.config.mjs` points `testDir` here instead, and
 * `node --test` never looks at this tree.
 */

import fs from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * A server rooted at `root`, which refuses to serve anything outside it.
 *
 * The containment check is not decoration: without it a request for `/../../etc/passwd` would be
 * served from outside the directory, and a test fixture that can read the filesystem is a fixture
 * that can make a failing assertion pass for the wrong reason.
 */
export function serve(root, { port = 0 } = {}) {
  const base = resolve(root);

  const server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = resolve(join(base, normalize(path)));

    if (target !== base && !target.startsWith(base + '/')) {
      res.writeHead(403).end('outside the served directory');
      return;
    }
    fs.readFile(target, (err, body) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    });
  });

  return new Promise((ok) => {
    server.listen(port, '127.0.0.1', () => {
      const at = server.address();
      ok({
        url: `http://127.0.0.1:${at.port}`,
        port: at.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// `node e2e/serve.mjs [root] [port]` — for looking at the artifact by hand.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const root = process.argv[2] || 'dist';
  const port = Number(process.argv[3] || 4173);
  const handle = await serve(root, { port });
  process.stdout.write(`serving ${root} at ${handle.url}\n`);
}
