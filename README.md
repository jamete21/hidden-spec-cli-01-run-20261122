[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jamete21/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jamete21/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend is one command-line tool that applies the edits AI models write to a tree of text files, in all four formats
models use: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor
tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation,
and it changes every file or none. `SPEC.md` is the whole contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file; when it is absent or `-`, the patch is read from standard input. `--format` picks one
format (`unified`, `search-replace`, `v4a`, `json`); `auto`, the default, detects it. `--check` does everything
but write. `--strict` matches lines exactly. On success it prints one line per changed file (`A`, `D`, `M`, or
`R old -> new`) and `ok: <n> files`; on failure it prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, and writes nothing.

## Matching

An edit's old lines are found at the first of three tiers that has a match: exact lines, lines equal once trailing
spaces and tabs are removed, or lines equal once leading and trailing spaces and tabs are removed. Context lines
are written back as the file's own lines, and at the loosest tier the new lines are re-indented to the file's
indentation. `--strict` tries the exact tier only.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts`
  when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts`
  on each one in a fresh directory, and posts the exit code, stdout and files.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (unified 30, SEARCH/REPLACE 20, V4A 20, JSON 15, command line 15):
practice score 1000.
