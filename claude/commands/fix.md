Run the linter, read all errors, fix each one, then verify the output is clean. Optionally run tests after.

## Steps

1. Detect linter from project type:
   - Go: `golangci-lint run ./...` (fall back to `go vet ./...` if not installed)
   - JS/TS: `eslint .` or `biome check .`
   - Python: `ruff check .`
   - Nix: `statix check`
2. Collect all errors and warnings — do not fix blindly, read each one
3. Fix errors in order: compilation errors first, then lint warnings
4. Re-run linter after fixes to confirm clean
5. If `--test` flag is passed, run `/test-all` after clean lint

## Flags

- `--test`: run tests after lint passes
- `--lint-only`: only fix lint, skip any build errors

## Rules

- Do not suppress lint rules with `//nolint` or similar unless the warning is genuinely a false positive — explain why if you do
- Fix the root cause, not the symptom (e.g. fix the logic, don't just cast away a type error)
- If a fix requires architectural changes beyond the scope of linting, surface it and ask before proceeding
- Loop until the linter reports zero issues
