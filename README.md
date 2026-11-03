<p align="center">
  <img src="docs/banner.png" alt="Potemkin: your agent's tests are green; Potemkin guts the code and runs them again" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/potemkin-cli"><img src="https://img.shields.io/npm/v/potemkin-cli?color=8a6a48&label=npm" alt="npm"></a>
  <a href="https://github.com/rosehgal/potemkin/actions/workflows/ci.yml"><img src="https://github.com/rosehgal/potemkin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-1f1a17" alt="Node 22.18+">
  <img src="https://img.shields.io/badge/runs-100%25%20local-2f7d4a" alt="Runs 100% local">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-e0a93b" alt="MIT"></a>
</p>

<h3 align="center">Your coding agent's tests are green.<br>Potemkin guts the code they test and runs them again.</h3>

```bash
npx potemkin-cli
```

It finds every function your diff touched, makes each one return nothing, and reruns only the tests related to it. A test that still passes was never checking that function. It was a facade.

<p align="center">
  <img src="docs/demo.gif" alt="Terminal: vitest shows 5 tests passing, then npx potemkin-cli finds that 3 of 6 changed functions could be gutted with every test still green" width="100%">
</p>

<sub>Demo runs on the sample repo from <a href="scripts/demo.ts"><code>scripts/demo.ts</code></a>.</sub>

## Four verdicts

| | Verdict | Meaning |
|---|---|---|
| 🟢 | **NOTICED** | a related test failed when the function was gutted |
| 🔴 | **HOLLOW** | tests call it (they fail when it throws), yet all of them pass when it returns nothing |
| 🟡 | **UNTESTED** | no passing related test calls it at all |
| ⚪ | **UNVERIFIABLE** | Potemkin could not tell, and says why: no runner, tests already failing, tests that do not load the sandbox copy |

The headline is HOLLOW plus UNTESTED: functions that could be deleted outright without a single test turning red.

> **Your files are only read.** Potemkin copies the repo to a temp directory, mutates the copy, and deletes it when done, including on Ctrl-C. No account, no API key, no network, no telemetry.

## How it works

```
git diff ──▶ changed lines ──▶ innermost named function around each one
                                          │
                     copy of the repo in $TMPDIR (node_modules / .venv linked in)
                                          │
   baseline run of the related tests ── tests that already fail are left out
                                          │
   EMPTY mutant: body → `return undefined` ── any test red? ──▶ NOTICED
                                          │ all green
   THROW mutant: body → `throw`        ── any test red? ──▶ HOLLOW (it ran, nothing checked it)
                                          │ all green
                                          ▼
                                       UNTESTED ── canary: do the tests load this copy at all?
                                                     no ──▶ UNVERIFIABLE, never an accusation
```

- **Related tests** come from the runner itself: `vitest related`, `jest --findRelatedTests`, and for pytest the test files that import the module (or the whole suite).
- **Conservative by default.** A crash, a timeout or unreadable runner output counts as "noticed". Potemkin never calls a test hollow on a maybe.
- **Fast.** One run per function when a test notices, two when none does. The sample repo takes 2 seconds.

## Share card

```bash
npx potemkin-cli --share
```

Renders `potemkin-card.png` locally (satori + resvg), sized for X, LinkedIn and Slack.

<table>
  <tr>
    <td width="50%"><img src="docs/card.png" alt="Card: 3 of 6 functions your agent changed could be gutted, and every test would still pass"></td>
    <td width="50%"><img src="docs/card-clean.png" alt="Card: all 6 functions your agent changed are pinned by a test"></td>
  </tr>
  <tr>
    <td align="center"><sub>Facade</sub></td>
    <td align="center"><sub>Load-bearing</sub></td>
  </tr>
</table>

The card names functions and the repo folder, so read it before you post it.

## Real numbers

REAL_NUMBERS

## Guard: send the agent back before you read its diff

`potemkin guard` is a Claude Code Stop hook. When the agent finishes a turn with uncommitted changes, it checks them (at most 10 functions, inside the hook's time limit). If any function is HOLLOW, it blocks the stop and hands the agent the list, so it fixes the tests or tells you plainly that they check nothing.

```bash
npx potemkin-cli install     # adds the hook to ~/.claude/settings.json
npx potemkin-cli uninstall   # removes it
```

Both are idempotent and leave your other hooks alone. The hook stands down when Claude Code marks the stop as a retry (`stop_hook_active`), so it blocks at most once per turn, and any error inside it lets the stop through.

## Options

```
--base REF       compare with REF (default HEAD: your uncommitted work, or the last commit if there is none)
--max N          check at most N functions (default 40; guard 10)
--timeout S      seconds per test run before it counts as noticed (default 120)
--share          also render the share card
--out FILE       card path (default ./potemkin-card.png)
--json           every function with its verdict, reason and tests
-v, --version    print the version
```

Supports **vitest**, **jest** and **pytest**, on JavaScript, TypeScript (including JSX/TSX) and Python. Exit codes: 0 on success (whatever the verdicts), 1 on an unexpected error, 2 on a bad flag. Set `DEBUG=1` for stack traces.

## Is this mutation testing?

Yes, the most extreme kind. Classic mutation testing (flip `<` to `<=`, `+` to `-`) asks whether your tests catch small bugs, and it is slow because it tries thousands of mutants. Potemkin asks a blunter question, once per function: would any test notice if this function did nothing at all? That is the failure mode of agent-written tests: they call the code and assert nothing about it.

| | Potemkin | [Stryker](https://github.com/stryker-mutator/stryker-js) | [mutmut](https://github.com/boxed/mutmut) | [cargo-mutants](https://github.com/sourcefrog/cargo-mutants) |
|---|---|---|---|---|
| Scope | functions in your diff | whole project (or `--incremental`) | whole project | whole crate (or `--in-diff`) |
| Mutants per function | 2 (return nothing, throw) | many operators | many operators | a few return-value replacements |
| Typical run on a diff | seconds | minutes | minutes | minutes |
| Agent hook | Claude Code Stop hook | no | no | no |
| Languages | JS, TS, Python | JS, TS, C#, Scala | Python | Rust |

If you want full mutation scores, use those tools. Potemkin is the 10-second check you run before you trust a green diff. (Its "return nothing" mutant is the same idea as Descartes' extreme mutation for Java.)

## FAQ

**Why a sandbox?** Mutating your files in place would be faster, but a crash or Ctrl-C at the wrong moment would leave a gutted function in your working tree, and a parallel agent might read it. Potemkin copies everything git can see, links `node_modules`, `.venv` and root `.env` files in read-only use, and removes the copy when it exits.

**What does UNVERIFIABLE mean?** Potemkin could not get an honest answer. Common causes: the related tests already fail (no database running, say), no supported runner, or a workspace link or editable install that makes the tests load the original checkout instead of the sandbox copy. Potemkin detects that last case with a canary (a `throw` at the top of the file) and refuses to judge.

**Why does it say UNTESTED when I have an integration test for it?** If that test fails before any change (for example because it needs a database), Potemkin leaves it out and says so in the reason. Start your services and run it again.

**Does it work with Codex, Cursor, Gemini CLI?** The check works on any git diff, whoever wrote it. The guard hook is Claude Code only for now.

## Also

[Pinocchio](https://github.com/rosehgal/pinocchio) checks your agent's "all tests pass" against the commands it actually ran. Potemkin checks whether those tests test anything.

## License

MIT
