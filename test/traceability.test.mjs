/*
 * traceability.test.mjs — the test that makes the specification load-bearing (`09-testing.md` §3).
 *
 * Without this file the documents and the code drift within a few iterations: a requirement is added,
 * implemented, and never checked; a test is written for something nobody asked for and stays forever.
 * Both are invisible in review, because each one is locally reasonable. The rule is therefore
 * bidirectional and both directions are asserted here:
 *
 *   every requirement names at least one test   — nothing is written and forgotten
 *   every test is named by some requirement     — nothing accumulates that nobody asked for
 *
 * **How names are collected, and why it is a second implementation.** `test/lib/check.mjs` refuses an
 * uncited name at load time, which catches a typo in the file you are running. This file instead
 * parses the *sources*, which catches what a runtime check structurally cannot: a test that was
 * deleted, or a whole file that stopped being loaded. Neither mechanism subsumes the other, and the
 * redundancy is deliberate.
 *
 * The collection is textual on purpose. Importing every test module to ask it what it declared would
 * run the suite — which is what `node --test` is for — and would make this file's verdict depend on
 * the order the modules happened to load in.
 *
 * **The cases below are not themselves cited.** They are assertions about the specification and the
 * suite rather than behaviours any requirement asks for, so there is no cited name for them to carry.
 * They are declared with `node:test` directly, under ordinary prose names, and the collector does not
 * look for those — which is what keeps the exemption list at one entry, where `09-testing.md` §3 says
 * it belongs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import { ROOT } from './lib/app.mjs';
import { EXEMPT, TEST_NAME, readFrozenRegistry, readSpec } from './lib/spec.mjs';

const { requirements, cited, registry } = readSpec();

/**
 * Every `.mjs` the suite declares names in: `test/` (excluding the harness in `test/lib/`) and the
 * browser specs in `e2e/`.
 *
 * `e2e/` is a second root for a mechanical reason. `node --test` with no path arguments imports every
 * `.js`/`.mjs` under any directory named `test/`, so a Playwright spec kept there would be imported by
 * the unit runner, which has no `test` fixture for it to take and no browser to give it. The specs
 * therefore live beside `test/` rather than inside it (`playwright.config.mjs` points at them) — but
 * they declare their names with `e2eTest(…)` exactly like the unit tests declare theirs with
 * `specTest(…)`, and a collector that read only `test/` would report ten cited names as defined
 * nowhere. The `09-testing.md` §3 rule is about the suite, not about a directory.
 */
function testFiles() {
  const out = [];
  const roots = [join(ROOT, 'test'), join(ROOT, 'e2e')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const rel = relative(ROOT, join(entry.parentPath, entry.name));
      // `test/lib/` is the machinery the tests are written against, not a test. Collecting it would let
      // a name mentioned inside `check.mjs`'s own error message count as a defined test.
      if (rel.startsWith(join('test', 'lib'))) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * The suite names a source declares — the `specTest('…')` and `e2eTest('…')` calls.
 *
 * The negative lookbehind keeps a `t.test(…)` *subtest* out of the collection: a subtest is part of
 * the case that contains it and is not separately cited. A name is only collected if it has the shape
 * of a suite name, so an incidental string literal could not become a phantom citation either.
 */
function declaredIn(source) {
  const names = new Set();
  for (const m of source.matchAll(/(?<![\w.])(?:specTest|e2eTest)\(\s*'([^']+)'/g)) {
    if (TEST_NAME.test(m[1])) names.add(m[1]);
  }
  return names;
}

const FILES = testFiles();
const declared = new Map(); // name -> [file, …]
for (const file of FILES) {
  for (const name of declaredIn(fs.readFileSync(join(ROOT, file), 'utf8'))) {
    if (!declared.has(name)) declared.set(name, []);
    declared.get(name).push(file);
  }
}

test('every requirement names at least one test', () => {
  // A requirement with no test is a spec bug (`CLAUDE.md`), not a missing test: an acceptance
  // criterion nobody checks is an intention, and the point of the id is that it can be pointed at.
  const bare = requirements.filter((r) => r.tests.length === 0).map((r) => r.id);
  assert.equal(
    bare.length,
    0,
    `these requirements name no test at all, so nothing verifies them: ${bare.join(', ')}. A new ` +
      `requirement needs a \`- **Test:**\` line naming a test (09-testing.md §3).`,
  );
});

test('every cited test name exists in the suite', () => {
  // The other direction, half one: a citation of a test that was never written. This is the failure a
  // reader most expects to be caught, and it is what catches a rename performed in the suite but not
  // in the specification — the id still resolves, and points at nothing.
  const missing = [...cited.keys()].filter((name) => !declared.has(name)).sort();
  assert.equal(
    missing.length,
    0,
    `${missing.length} cited test name(s) are named by the specification and defined nowhere:\n` +
      missing.map((n) => `  ${n}  <- ${cited.get(n).join(', ')}`).join('\n'),
  );
});

test('no test is defined that nothing cites', () => {
  // The other direction, half two: a test nobody asked for. The exemption list is the one escape
  // hatch (`09-testing.md` §3), and it is meant to be short enough to read — so this assertion is
  // what gives the list its meaning rather than letting it become a place to put anything awkward.
  const exempt = new Set(EXEMPT);
  const orphans = [...declared.keys()].filter((name) => !cited.has(name) && !exempt.has(name)).sort();
  assert.equal(
    orphans.length,
    0,
    `these tests are defined but no requirement or citing table names them:\n` +
      orphans.map((n) => `  ${n}  (${declared.get(n).join(', ')})`).join('\n') +
      `\n\nA test nothing asks for has to be either renamed to a cited name or added to EXEMPT in ` +
      `test/lib/spec.mjs, which is a deliberate act and should look like one in review.`,
  );
});

test('every exempt name is still a test that exists', () => {
  // An exemption for a test that no longer exists is worse than no exemption: it reads as "this name
  // is accounted for" while accounting for nothing, and it would silently absorb the next test that
  // happened to take the name.
  const dead = EXEMPT.filter((name) => !declared.has(name));
  assert.equal(
    dead.length,
    0,
    `the build-integrity exemption list names tests that do not exist: ${dead.join(', ')}. Remove ` +
      `the entry, or restore the test.`,
  );
});

test('requirement ids are unique', () => {
  // `CLAUDE.md`: never renumber or reuse an id. Two requirements sharing one id makes every citation
  // of it ambiguous, and the ambiguity is silent — both statements exist, and a test cites "it".
  const seen = new Map();
  const clashes = [];
  for (const req of requirements) {
    if (seen.has(req.id)) clashes.push(`${req.id} (${seen.get(req.id)} and ${req.title})`);
    else seen.set(req.id, req.title);
  }
  assert.equal(clashes.length, 0, `duplicate requirement ids: ${clashes.join('; ')}`);
});

test('no id has been reused for a different statement', () => {
  // The registry is a digest of each requirement's statement, frozen at `test/lib/id-registry.json`.
  // Retiring a requirement and recycling its number is the edit this catches, and it is the one that
  // cannot be caught any other way: the new statement is perfectly well-formed, cites tests of its
  // own, and every citation of the old id now quietly points at something else.
  const frozen = readFrozenRegistry();
  const changed = [];

  for (const [id, entry] of registry) {
    const was = frozen.get(id);
    if (!was) changed.push(`${id} is new — re-freeze the registry if the addition is intended`);
    else if (was.statement !== entry.statement) {
      changed.push(`${id} no longer has the statement the registry froze ("${was.title}" -> "${entry.title}")`);
    }
  }
  for (const id of frozen.keys()) {
    if (!registry.has(id)) changed.push(`${id} was retired; it must not be reused for another requirement`);
  }

  assert.equal(
    changed.length,
    0,
    `the requirement registry and the specification disagree:\n` +
      changed.map((line) => `  ${line}`).join('\n') +
      `\n\nRe-freezing is a human act, not something this suite does — a test that regenerated the ` +
      `file it compares against would assert nothing (test/lib/spec.mjs).`,
  );
});

test('the requirement domains are the eleven', () => {
  // The domain list is prose in `CLAUDE.md` and a count in `09-testing.md` §3, and both go stale
  // silently. Asserting the set means a twelfth domain is a visible act, and — more usefully — that a
  // requirement typed into the wrong domain (`REQ-VIEW-` for a UI concern) shows up as an unexpected
  // name rather than passing because the parser does not care which domain it is.
  const domains = new Set(requirements.map((r) => r.id.replace(/^REQ-/, '').replace(/-\d+$/, '')));
  assert.deepEqual(
    [...domains].sort(),
    ['DATA', 'EDIT', 'EXP', 'IMP', 'SEC', 'SHELL', 'STORE', 'SYNC', 'UI', 'VCS', 'VIEW'],
  );
});

test('every citing document exists', () => {
  // A citation source that is not a requirement id is a document path. Every one must exist, so the
  // widened citation sources in `test/lib/spec.mjs` cannot be pointed at a file that was renamed —
  // which would silently drop a whole table of tests back into the orphan list.
  const sources = new Set();
  for (const ids of cited.values()) for (const id of ids) if (!id.startsWith('REQ-')) sources.add(id);
  assert.ok(sources.size > 0, 'no citing documents were found, so the citation sources are not being read');
  for (const doc of sources) {
    assert.equal(fs.existsSync(join(ROOT, doc)), true, `a citing document is named but does not exist: ${doc}`);
  }
});

test('the collector is not silently finding nothing', () => {
  // A guard on the collector itself, and the most important case in this file. Every assertion above
  // passes vacuously if the source parse comes back empty — no orphans, no missing tests, no
  // disagreements — so a suite that had quietly stopped declaring names in the expected form would
  // report perfect traceability forever. This is the case that fails instead.
  assert.ok(FILES.length >= 5, `only ${FILES.length} test file(s) were found under test/`);
  assert.ok(declared.size >= 100, `only ${declared.size} test names were collected from ${FILES.length} files`);
  assert.ok(requirements.length >= 100, `only ${requirements.length} requirements were parsed`);
  assert.ok(cited.size >= 150, `only ${cited.size} cited names were parsed from the specification`);
});
