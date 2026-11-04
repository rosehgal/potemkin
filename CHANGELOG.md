# Changelog

## 0.1.0

First release.

- `npx potemkin-cli` finds the functions your diff changed (by structure, so comments, formatting and neighbouring edits do not count), guts each one in a throwaway copy of the repo, and reruns the tests: NOTICED, HOLLOW, UNTESTED or UNVERIFIABLE.
- vitest, jest and pytest; JavaScript, TypeScript (JSX/TSX included) and Python.
- Before any accusation, the whole suite is asked which tests load the file, so dynamic imports, subprocess tests, fixtures and monorepo packages are counted.
- Conservative: crashes, timeouts, unreadable output and related tests that already fail never become HOLLOW or UNTESTED.
- `--share` renders a PNG card; `--json` for tools; `--strict` for CI; `--base` diffs from the branch point.
- `npx potemkin-cli install` adds a Claude Code Stop hook that sends the agent back once when its tests are hollow.
