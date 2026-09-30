/*
 * fixtures.mjs — where the artifact is, and how a spec gets a browser pointed at it.
 *
 * Every end-to-end test in this suite runs against **the built artifact** and nothing else
 * (`09-testing.md` §2). That is not a convenience: the whole design rests on properties of the
 * produced file — one inline classic script, a CSP hash that has to still match after concatenation,
 * a pristine clone taken before anything renders — and a spec that loaded `src/` in a page would be
 * testing a different program. So there is one path here, `dist/threat-model-viewport.html`, and a
 * spec that needs the file needs `node build.mjs` to have been run first.
 *
 * The protocol half of the matrix (`09-testing.md` §4) needs the same bytes over two schemes: the
 * artifact is `file://`-ed in place for one, and copied into a temporary directory that `serve.mjs`
 * hands out for the other. The copy matters — serving `dist/` directly would leave the exports these
 * tests write next to the artifact, and a test that can leave files in the build output can make a
 * later run pass for the wrong reason.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root. */
export const ROOT = path.resolve(HERE, '..');

/** The built artifact, and the name it is served under. */
export const DIST = path.join(ROOT, 'dist');
export const ARTIFACT_NAME = 'threat-model-viewport.html';
export const ARTIFACT = path.join(DIST, ARTIFACT_NAME);

/** The artifact's text. Read fresh, so a rebuild between runs is picked up. */
export function artifactText() {
  return fs.readFileSync(ARTIFACT, 'utf8');
}

/** The artifact in place, over `file://`. */
export function fileUrl() {
  return pathToFileURL(ARTIFACT).href;
}

/**
 * A temporary directory for one test, removed when it is done.
 *
 * Per test rather than per run: several specs write an export, open it, and compare it with another,
 * and a shared directory would let one spec's leftovers satisfy another's assertion.
 */
export function makeWorkdir(prefix = 'tmv-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(dir, name, text) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, text, 'utf8');
  return target;
}

/** The `file://` URL a file written into `dir` will have. */
export function fileUrlOf(dir, name) {
  return pathToFileURL(path.join(dir, name)).href;
}

/**
 * A copy of the artifact over `http://localhost`, from its own directory.
 *
 * The copy is what lets an export be opened over HTTP as well as from disk: `urlOf` names a file
 * written into the same directory, which is the whole of what a second protocol needs.
 */
export async function serveCopy(text) {
  const dir = makeWorkdir('tmv-e2e-http-');
  fs.writeFileSync(path.join(dir, ARTIFACT_NAME), text, 'utf8');
  const handle = await serve(dir, {});
  return {
    kind: 'http',
    dir,
    url: handle.url + '/' + ARTIFACT_NAME,
    /** The URL a file written into this server's directory will have. */
    urlOf: (name) => handle.url + '/' + name,
    close: handle.close,
  };
}

/**
 * The same artifact reached over `file://`, with a directory exports can be written into.
 *
 * `file://` needs no server and no directory of its own for the artifact — it is opened where it was
 * built — but an export still has to land somewhere, and putting it beside the artifact would leave
 * files in the build output.
 */
export function fileTarget(text) {
  const dir = makeWorkdir('tmv-e2e-file-');
  fs.writeFileSync(path.join(dir, ARTIFACT_NAME), text, 'utf8');
  return {
    kind: 'file',
    dir,
    url: pathToFileURL(path.join(dir, ARTIFACT_NAME)).href,
    urlOf: (name) => pathToFileURL(path.join(dir, name)).href,
    close: async () => {},
  };
}

/**
 * Both protocols for the matrix, from one artifact text, with teardown.
 *
 * `e2e.matrix.protocol` is REQ-SHELL-004's "every end-to-end test in the suite passes on both
 * protocols", so the two halves have to be the same bytes reached two ways rather than two builds.
 * The `file://` half is opened from a temporary copy rather than from `dist/` for one reason: this
 * journey writes exports next to whatever it opened, and a test that can leave files in the build
 * output can make a later run pass for the wrong reason.
 */
export async function protocolMatrix(text) {
  const file = fileTarget(text);
  const http = await serveCopy(text);
  return { file, http, close: http.close };
}
