# 05 — Storage

Persistence, the model registry, quota behaviour, and the consequences of browser origin rules.

The single most important sentence in this document: **storage is a cache, never the source of
truth.** Everything here follows from that. See ADR-0001.

Related: `04-versioning.md` (what is being stored), `02-architecture.md` §10 (why not IndexedDB).

---

## 1. The adapter

All storage access goes through one adapter (REQ-STORE-001). No feature module touches `localStorage`.

```
interface StorageAdapter {
  isAvailable(): boolean
  read(key): string | null
  write(key, value): void            // throws QuotaError | StorageUnavailable
  remove(key): void
  keys(prefix): string[]
  usage(): { bytes, keys }           // our own accounting, not the browser's
  subscribe(fn): unsubscribe         // cross-tab change notification
}
```

Three implementations:

| Implementation | When | Behaviour |
|---|---|---|
| `LocalStorageAdapter` | Normal | Backed by `localStorage` |
| `MemoryAdapter` | `localStorage` throws or is absent | Full functionality, no persistence. Triggers REQ-STORE-007's notice |
| `NullAdapter` | Read-only mode | Reads permitted, writes refused with an explanatory error |

Read-only mode (REQ-VIEW-008) uses `NullAdapter` deliberately rather than an `isReadOnly` flag, so
"can this be written?" is answered in one place instead of at every call site.

### The write/remove ordering invariant

`localStorage` has no transactions. A write spanning multiple keys can be interrupted by a closing
tab, a crash, or a quota error mid-sequence. The invariant that makes interruption survivable:

> **The pointer is written last and removed first.**

- **Committing:** write every blob (snapshots, deltas), then update the model meta (which holds the
  head). An interruption leaves unreferenced blobs — garbage, collected later, harmless.
- **Deleting:** remove the registry entry first, then the blobs. An interruption leaves orphaned
  blobs, not a registry entry pointing at missing commits.

The failure mode this avoids is a **dangling pointer**: a head referencing commits that do not exist.
That is corruption; orphans are merely waste. Every storage operation is ordered by this rule.

---

## 2. Keys

Namespaced, with a storage format version so the layout can change without a flag day
(REQ-STORE-002).

| Key | Contents |
|---|---|
| `tmv:1:prefs` | UI preferences and identity — user-scoped, not model-scoped |
| `tmv:1:registry` | Index of known models |
| `tmv:1:model:<modelId>:meta` | Head commit id, commit count, keyframe interval, byte accounting, write token |
| `tmv:1:model:<modelId>:snap:<commitId>` | A keyframe's full model snapshot |
| `tmv:1:model:<modelId>:delta:<commitId>` | A non-keyframe commit's JSON Patch |
| `tmv:1:model:<modelId>:cmeta:<commitId>` | The commit record minus `snapshot`/`delta` |

Snapshots are stored as separate keys from commit records for one reason: **quota accounting**. A
keyframe can be hundreds of kilobytes and a commit record a few hundred bytes, and the adapter needs
to know which is which to report usage and to decide what compaction should target.

Splitting them also means a commit's metadata can be read — for the History list, for ancestry walks —
without pulling its payload.

### `prefs`

```json
{
  "theme": "cds--g10",
  "activeTab": "threats",
  "sideNavCollapsed": false,
  "identity": { "name": "…", "email": "…" },
  "keyframeInterval": 20,
  "lastModelId": "…"
}
```

Identity lives here, not in the model, because who is *using* the app is not a property of the model
(`03-data-model.md` §8). Changing it affects subsequent commits only (REQ-VCS-015 AC2).

A corrupt `prefs` value is discarded and replaced with defaults. Preferences are the one thing that
may be silently reset — losing a theme choice is not losing work.

### `registry`

```json
[{
  "modelId": "…",
  "name": "Payments Platform",
  "headCommitId": "sha256:…",
  "commitCount": 42,
  "bytes": 183000,
  "lastOpenedAt": "2026-09-28T12:00:00Z",
  "sourceHint": { "filename": "payments.html", "format": "container" }
}]
```

`bytes` is our own accounting (§5), not a query to the browser. `sourceHint` is purely to help a human
recognise an entry — it is never used to locate a file, because the app cannot read the filesystem.
`name` is the model's name at storage's head, not the name in whichever file was opened last (§3).

---

## 3. Seeding and the registry's limits

The registry is **upserted from embedded data on every load** (REQ-STORE-003), not only on first load.
This is not redundancy; it is the mechanism that makes the design survive partitioned storage.

| Scenario | Outcome |
|---|---|
| First run, storage empty | Registry populated from the file |
| Firefox, `file://`, per-file origin | Each file populates its own registry — expected, and explained (REQ-SYNC-008) |
| User cleared site data | Repopulated on next open |
| Model deleted from registry, file reopened | Reappears — correct, because the file still carries it |
| Chrome, shared `file://` origin | One registry accumulates every model ever opened locally |

That last row is both the feature and the hazard. It is the behaviour that makes the model switcher
(REQ-UI-004) useful on Chrome, and it is the behaviour that means any HTML file saved to disk can read
every stored model. Both are documented in `08-security.md`.

**One field is not refreshed from the file: the entry's name.** Storage's own record describes what is
stored, so once a `meta` exists the entry keeps the name at storage's head, and the file's embedded
name fills in only where storage has no record at all. The name in a file is a snapshot of whenever it
was exported, so preferring it would revert a rename on the next reload even though the stored history
carries the newer name — `model.name` is an ordinary model field (`03-data-model.md` §2) and
REQ-EDIT-011 makes it editable. The commit path is what sets it: `saveModel` writes the name the
committed model carries. The `meta` and registry writes are not atomic, so a save that fails between
them leaves the entry's name one commit behind until the next successful save. Nothing is lost when
that happens — the committed history is the record, and the name catches up from it.

**The registry is a convenience index, not an authority.** If it disagrees with a file about the model
itself, the file wins — the entry's own name, above, is the single exception. If it is empty but files
exist, nothing is lost — they repopulate on open. This is why registry loss is survivable while history
loss is not.

---

## 4. The registry, per browser

Because `file://` origin behaviour was never standardised, the same file behaves differently depending
on how it was opened. This table is the honest version, and the app states the applicable row in its
About panel (REQ-SHELL-005).

| Browser | `file://` storage scope | Practical effect |
|---|---|---|
| Chrome, Edge | **One shared origin** for all local files | Model switcher spans everything ever opened locally. Convenient; also the exfiltration surface in `08-security.md` |
| Firefox 92+ | **Per-file-path origin** | Storage does not follow a moved, renamed, or copied file. Each file has its own registry. Explained at REQ-SYNC-008 |
| Safari | Inconsistent, historically restrictive | Feature-detected at runtime; never assumed |

The same model opened via `file://` and via `http://localhost` lands in two unrelated stores. The app
cannot bridge this and does not pretend to — the file is the bridge.

### Detection

```
detectStorageContext():
  if !adapter.isAvailable()                 → UNAVAILABLE
  if protocol is file:                       → FILE_ORIGIN
      if isFirefox() && registryEmpty && fileHasHistory → FILE_ORIGIN_PARTITIONED
  else                                       → WEB_ORIGIN
```

`FILE_ORIGIN_PARTITIONED` is a heuristic, not a certainty — an empty registry on a first run looks
identical. It is therefore expressed in the UI as a likely explanation with the file-based path
offered alongside, never as a diagnosis. Getting this wrong in either direction is cheap; presenting a
guess as fact is not.

---

## 5. Quota

`localStorage` is roughly 5 MB per origin. Two models with long histories can approach it, and the
failure is a thrown exception at write time, mid-operation.

### Accounting

Browsers do not expose remaining quota reliably. The adapter therefore keeps its own tally (§2's
`bytes`), incremented on write and decremented on remove, and cross-checks with
`navigator.storage.estimate()` where that is available (it is not, on `file://`).

### Thresholds

| Level | Trigger | Behaviour |
|---|---|---|
| **Normal** | < 70% | Silent |
| **Elevated** | ≥ 70% | A quiet indicator in Settings → Storage |
| **Warning** | ≥ 85%, or a projected write would cross it | Pre-flight notice **before** writing, naming the model and the options |
| **Exhausted** | The platform throws | Operation fails cleanly, nothing is removed, and the recovery dialog opens |

The pre-flight check is the important one. Writing until the platform throws means a commit that
fails *after* partial writes, which the ordering invariant makes survivable but which is still a bad
experience. Estimating first turns a failure into a choice.

### Recovery options, in order of preference

1. **Export** — always available and always safe. Removes nothing (REQ-EXP-013).
2. **Compact** — re-keyframe and drop redundant keyframes. Preserves every reachable commit
   (REQ-STORE-006 AC2).
3. **Remove another model** — the user picks. Names its size and commit count.
4. **Prune this model's history** — the explicit, informed, last resort.

### The rule that overrides everything else

**No code path deletes commits without explicit user confirmation** (REQ-STORE-006). Not on quota
pressure, not on corruption, not on migration failure, not on "obviously unreachable" data.

An eviction policy that quietly drops old commits to make room would be defensible in a cache. It is
not defensible here, because the history *is* the user's work — it may be the only copy, and its whole
purpose is to survive being passed around. A full disk that says so is better than a quiet one that
deletes.

---

## 6. Concurrent access

Two browser tabs can hold the same model at the same time. `localStorage` is not transactional, and
the `storage` event fires in *other* tabs, not the writer's — so a naive implementation loses updates
silently.

**Optimistic concurrency on commit:**

```
commit(model):
  meta = adapter.read(metaKey)
  if meta.writeToken != loadedWriteToken:      // someone else committed
      refuse → reload, compare, prompt         // do not overwrite
  ...write blobs...
  meta.head = newHead
  meta.writeToken = newToken
  adapter.write(metaKey)
  loadedWriteToken = newToken
```

Re-checking immediately before the head update closes most of the remaining window; localStorage
operations are synchronous and single-threaded per origin, so the check-and-update pair cannot be
interleaved within a tab.

A refused commit is recoverable by design: the working copy is untouched, and the user is routed into
the compare view (§`04-versioning.md` §6) rather than told to try again and hope.

The `storage` event is also used **advisory**: another tab's write raises a notice offering to reload.
Advisory only, because the event does not fire reliably on `file://` in all browsers, and correctness
must not depend on it.

> **Open question** — whether cross-tab editing deserves a full workflow (a lock, a "take over"
> action) is deferred. See `10-open-questions.md`. v1 detects and refuses; it does not coordinate.

---

## 7. Deletion

Deleting a stored model (REQ-STORE-005) is the only destructive operation in the app, so it is
specified precisely.

1. Confirmation names the model, its commit count, and its size.
2. Confirmation states plainly that **the file on disk is not deleted** — the most likely
   misunderstanding, since the user's mental model is that the app *is* the file.
3. If it is the currently open model, the UI returns to the embedded data rather than to an empty
   state.
4. Removal follows the ordering invariant: registry entry first, then blobs.
5. The embedded model remains switchable, because it is in the file (REQ-STORE-004 AC2).

There is no undo. The file is the backup, and the confirmation says so.

---

## 8. Storage format migration

The `:1:` segment is the storage format version, independent of the container format
(`03-data-model.md` §7) and of the app version.

| Situation | Behaviour |
|---|---|
| Stored version older | Migrated on load; old keys removed **only after** the migrated data is written and verified |
| Stored version newer | Ignored, not deleted. A newer app's data is not ours to destroy |
| Unrecognised key shapes | Skipped, counted, and reported — never removed |

Migration follows the ordering invariant too: build the new layout completely, verify it, then remove
the old. A crash leaves both, which is recoverable; the reverse order is not.

---

## 9. Testing storage

Storage behaviour is where the browser differences live, so it is tested across the matrix rather than
assumed (`09-testing.md`).

| Test | What it exercises |
|---|---|
| `store.origin-partitioned` | Same file, two origins — storage does not carry over, and the app says so |
| `store.registry-reseed` | Clear storage, reopen a file, registry repopulates |
| `store.registry-name-follows-head` | Reopen a file after a committed rename — the entry keeps the stored name, not the file's |
| `store.quota-preflight` | A write projected over the threshold warns before writing |
| `store.quota-exhausted` | Platform throws → clean failure, nothing removed, recovery offered |
| `store.interrupted-commit` | Kill between blob write and head update → orphan, not dangling pointer |
| `store.concurrent-commit` | Second tab commits; first tab's commit is refused, not silently overwritten |
| `store.memory-fallback` | `localStorage` throwing → full function, notice shown |
| `store.migration-verify-before-remove` | Crash during migration → both layouts present, nothing lost |

`store.interrupted-commit` and `store.migration-verify-before-remove` are fault-injection tests —
they require a way to fail writes deliberately, so the adapter exposes a test hook for that. The hook
is compiled out of release builds.
