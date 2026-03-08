Run the full test suite for the current project: unit tests first, then e2e tests. Stop on first failure and report actionable output.

## Steps

1. Detect project type from working directory:
   - Go project (`go.mod` present): run `go build ./...` then `go test ./...`
   - Node project (`package.json` present): run `npm test` or `bun test`
   - Python project: run `pytest`
2. If e2e tests exist (detect by `playwright.config.*` or `e2e/` directory), run them after unit tests pass
   - Playwright: `npx playwright test` or `bunx playwright test`
3. Report: pass count, fail count, any failing test names with file:line
4. If any tests fail, list each failure with its error message — do not silently skip

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
