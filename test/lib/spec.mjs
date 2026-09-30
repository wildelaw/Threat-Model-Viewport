/*
 * spec.mjs — read the specification the way the traceability test needs to (`09-testing.md` §3).
 *
 * The rule is bidirectional and both halves are the point:
 *
 *   every requirement cites at least one test   — so nothing is written and forgotten
 *   every test is cited by at least one thing   — so nothing accumulates that nobody asked for
 *
 * **Where citations come from.** `01-requirements.md` carries a `- **Test:**` line per requirement,
 * and that is the primary source. Two other documents name suite tests in an explicit table rather
 * than through a requirement, and those tests are no less asked for: `05-storage.md` §9 (storage
 * behaviour that spans requirements — an interrupted commit, a second tab, a migration crash) and
 * `06-interchange.md` §11 (differential interchange tests, which no single requirement owns because
 * each one cuts across the OTM and TML mapping requirements). Reading only `01-requirements.md`
 * would push eight real tests into a list meant for tests *nobody* asked for, which would make the
 * exemption list a place to hide rather than a deliberate exception — and `09-testing.md` §3 is
 * explicit that it should stay one entry long.
 *
 * **Names are shape-checked.** A citation only counts if it looks like `domain.name`: the
 * parenthetical in REQ-DATA-002 (`(cases: close-script, close-comment, line-separator)`) names three
 * *cases*, not three tests, and a parser that took every backticked word would demand three tests
 * that should not exist.
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ROOT } from './app.mjs';

const read = (rel) => fs.readFileSync(join(ROOT, rel), 'utf8');

/** `domain.name`, or `domain.name.thing` — every test in this suite is a dotted lowercase name. */
export const TEST_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const REQUIREMENT_ID = /^REQ-[A-Z]+-\d+$/;

/** Documents whose explicit test tables also cite suite tests. */
export const CITING_DOCUMENTS = ['specs/05-storage.md', 'specs/06-interchange.md'];

/**
 * Tests that check a condition of the release artifact rather than a behaviour anybody asked for.
 *
 * Adding to this list is meant to be visible in review — that is the property that makes the rule
 * worth having (`09-testing.md` §3).
 */
export const EXEMPT = ['store.no-test-hooks-in-release'];

/** Strip a fenced code block, so a `- **Test:**` line quoted inside an example is not a citation. */
function stripFences(text) {
  return text
    .split('\n')
    .map((line) => (line.trimStart().startsWith('```') ? '' : line))
    .join('\n');
}

export function parseRequirements(text) {
  const lines = stripFences(text).split('\n');
  const out = [];
  let current = null;
  let inTestLine = false;
  for (const line of lines) {
    const heading = /^### (REQ-[A-Z]+-\d+) — (.+)$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), tests: [], statement: [] };
      out.push(current);
      inTestLine = false;
      continue;
    }
    if (!current) continue;
    if (/^- \*\*Test:\*\*/.test(line)) {
      inTestLine = true;
    } else if (/^- \*\*/.test(line) || /^#{2,4} /.test(line)) {
      inTestLine = false;
    }
    if (inTestLine) {
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        if (TEST_NAME.test(m[1]) && current.tests.indexOf(m[1]) === -1) current.tests.push(m[1]);
      }
    }
    current.statement.push(line);
  }
  return out;
}

/**
 * The rows of a document's **testing section**: a first cell that is exactly one backticked test
 * name.
 *
 * The section boundary is load-bearing rather than tidy. `06-interchange.md` is mostly field mapping
 * tables, and their first cells are field paths — `project.name`, `metadata.version` — which are the
 * same shape as a test name and would sail through the shape check. Reading only from the heading
 * that names testing to the next `## ` heading is what keeps a field table from being mistaken for a
 * suite listing.
 */
export function parseTestTables(text) {
  const names = [];
  let inTesting = false;
  for (const line of text.split('\n')) {
    const heading = /^## \d+\.\s+(.*)$/.exec(line);
    if (heading) {
      inTesting = /test/i.test(heading[1]);
      continue;
    }
    if (!inTesting) continue;
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (!row) continue;
    if (TEST_NAME.test(row[1]) && names.indexOf(row[1]) === -1) names.push(row[1]);
  }
  return names;
}

/**
 * Everything the spec cites, and the frozen id registry the "no id reused" assertion reads.
 *
 * The registry is a digest of each requirement's **statement** — its heading and its body — keyed by
 * id. An id that reappears with different text is the failure this catches: retiring a requirement
 * and recycling its number for a different one leaves every citation of the old id pointing at the
 * new statement, and nothing else in the suite would notice.
 */
export function readSpec() {
  const requirements = parseRequirements(read('specs/01-requirements.md'));
  const cited = new Map(); // test name -> where it is cited
  for (const req of requirements) {
    for (const name of req.tests) {
      if (!cited.has(name)) cited.set(name, []);
      cited.get(name).push(req.id);
    }
  }
  for (const doc of CITING_DOCUMENTS) {
    for (const name of parseTestTables(read(doc))) {
      if (!cited.has(name)) cited.set(name, []);
      cited.get(name).push(doc);
    }
  }
  const registry = new Map();
  for (const req of requirements) {
    registry.set(req.id, {
      title: req.title,
      statement: createHash('sha256').update(req.statement.join('\n')).digest('hex').slice(0, 16),
    });
  }
  return { requirements, cited, registry };
}

/** The frozen id registry, as committed. `09-testing.md` §3.6 compares against this. */
export function readFrozenRegistry() {
  const path = join(ROOT, 'test', 'lib', 'id-registry.json');
  return new Map(Object.entries(JSON.parse(fs.readFileSync(path, 'utf8'))));
}

/**
 * Rewrite the frozen registry from the current spec.
 *
 * Deliberately a function a human calls and not something the suite does: a test that regenerates
 * the file it compares against asserts nothing. Re-freezing is the moment a retired id is struck
 * from the registry, and it is meant to be a diff someone reads.
 */
export function writeFrozenRegistry(registry) {
  const path = join(ROOT, 'test', 'lib', 'id-registry.json');
  const sorted = {};
  for (const id of [...registry.keys()].sort()) sorted[id] = registry.get(id);
  fs.writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}
