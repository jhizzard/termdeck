# `packages/server/src/vendor/` — byte-identical copies. Do not edit.

Every file in this directory is a **verbatim copy of a file that is authored in
another repository**. They are vendored rather than imported because TermDeck's
server is CommonJS with no build step and no dependency on the source repos —
so `import`ing the original is not executable here, and re-implementing it is
worse than either (see below).

**Never edit a file in this directory.** Fix the upstream original, then re-copy.
A local edit is invisible: nothing about a drifted copy looks broken from the
outside, which is the entire failure mode vendoring exists to make loud.

| Vendored file | Upstream source of truth |
|---|---|
| `problem_signature_core.cjs` | `engram/src/problem_signature_core.cjs` |

## `problem_signature_core.cjs`

Sprint 83, interface I3 (ORCH ruling 2026-07-31 14:47 ET). The normalizer that
turns a raw error string into `{ class, symptom, symptom_hash }`.

Three consumers must agree on that hash byte-for-byte — mnestra's write side
(ESM TypeScript, stamps the signature), the recall-side expansion, and this
server's flashback path (CommonJS, no TS, no mnestra dependency). They share no
module system, so the module is dependency-free `.cjs` with dual-export shape.

**Why a copy and not a re-implementation.** If any consumer re-derives the
normalization, its hashes silently never collide with the others'. Nothing
errors, nothing warns — the lookup just returns nothing, forever. A dead
feature that looks alive is strictly worse than one that throws.

**Parity is enforced twice, not assumed:**

1. **Bytes** — `tests/problem-signature-vendor.test.js` diffs this copy against
   the upstream file and fails on any difference. It skips (rather than fails)
   when the engram checkout is absent, so an external user's `npm test` does
   not depend on a second repo being present on disk.
2. **Behavior** — the same test runs the shared golden vectors through this
   copy, so the hashes are proven equal on both sides even in a checkout where
   the byte-diff cannot run.
