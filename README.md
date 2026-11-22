# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sapriyudin/hidden-spec-cli-01/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sapriyudin/hidden-spec-cli-01/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

An entry for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): build `mend`, a
zero-dependency Node 22 CLI that reads one patch in any of four formats — unified diff, SEARCH/REPLACE blocks,
the V4A patch format, or JSON edits — and applies it to a tree of text files, all or nothing.

`SPEC.md` is the whole contract. The implementation covers all ten of its sections, including the three-tier
line matching (exact, trailing-whitespace-insensitive, fully-whitespace-insensitive) with tier-2 re-indentation,
unified-diff hunk drift and nearest-occurrence selection, SEARCH/REPLACE path finding, V4A anchors and cursors,
and byte-exact output (`A`/`D`/`M`/`R` rows, `ok: n files`, `failed: k of n edits`).

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a path relative to the working directory; absent or `-` reads the patch from standard input.
`--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, detected per SPEC §4).
`--check` reports what would change without writing anything. `--strict` matches lines exactly (tier 0 only).

## Verify it

    node check.ts ../program/generator/practice.json

Practice score: **100/100 (1000)** on the kit's public practice set, plus a 79-case audit suite covering the
SPEC sentences the practice set does not show (exit-2 precedence, CRLF/final-newline edge cases, unsafe paths,
multi-hunk drift, nearest-tie, V4A anchors/cursor/EOF chunks, and cross-format forcing).

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts`
  when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, unchanged. In a trial it reads the checks from the env, runs `node main.ts` on
  each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
