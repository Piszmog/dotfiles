---
description: Run the full test suite (unit, then e2e)
argument-hint: "[--unit] [--e2e] [--fix]"
---
Run the full test suite for the current project: unit tests first, then e2e tests. Stop on first failure and report actionable output.

## Steps

1. Use the project's own command when it defines one: check `justfile`, `Makefile`, and `AGENTS.md` in the repo root (`just test`, `just ci`, `make test`). Those win over the language defaults below.
2. Otherwise detect project type from the working directory:
   - Go project (`go.mod` present): run `go build ./...` then `go test ./...` (add `-race` for packages you changed; use `-run`/`-count=1` while iterating)
   - Rust project (`Cargo.toml` present): run `cargo test` — it covers lib, integration, and doc tests, and builds examples; add `--all-targets` only when benches must compile too
   - Node project (`package.json` present): run `npm test` or `bun test`
   - Python project: run `pytest`
3. If e2e tests exist (detect by `playwright.config.*` or `e2e/` directory), run them after unit tests pass
   - Playwright: `npx playwright test` or `bunx playwright test`
4. Report: pass count, fail count, any failing test names with file:line
5. If any tests fail, list each failure with its error message — do not silently skip

## Flags

- `--unit`: run only unit tests, skip e2e
- `--e2e`: run only e2e tests
- `--fix`: after reporting failures, attempt to fix them (delegates to `/fix`)

## Output format

```
Unit tests:  ✓ 42 passed
E2e tests:   ✗ 2 failed
  - TestLoginFlow (e2e/auth_test.go:34): expected 200 got 401
  - TestCartCheckout (e2e/cart_test.go:89): timeout after 5s
```

Stop and surface the failure immediately — do not proceed to e2e if unit tests fail.
