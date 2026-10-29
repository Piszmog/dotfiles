---
description: Run the linter, fix every error, and verify clean
argument-hint: "[--test] [--lint-only]"
---
Run the linter, read all errors, fix each one, then verify the output is clean. Optionally run tests after.

## Steps

1. Use the project's own lint task when it defines one: `just lint`, `make lint`, or a command in the project `AGENTS.md`. Those win; the list below is the fallback.
2. Otherwise detect linter from project type:
   - Go: `golangci-lint run ./...` (fall back to `go vet ./...` if not installed)
   - Rust: `cargo fmt --check` (report the diffs), then `cargo clippy --all-targets -- -D warnings` — apply `cargo fmt` as a fix, not as part of collecting findings
   - JS/TS: `eslint .` or `biome check .`
   - Python: `ruff check .`
   - Nix: `statix check`
3. Collect all errors and warnings — do not fix blindly, read each one
4. Fix errors in order: compilation errors first, then lint warnings
5. Re-run linter after fixes to confirm clean
6. If `--test` flag is passed, run `/test-all` after clean lint

## Flags

- `--test`: run tests after lint passes
- `--lint-only`: only fix lint, skip any build errors

## Rules

- In Rust workspaces, read `Cargo.toml` `[lints]` and `clippy.toml` first: project-level `pedantic`/`-D warnings` means a large warning set is expected. Fix findings in the files you changed; do not refactor unrelated code to satisfy pedantic lints, and never introduce `unsafe` to silence a lint when the crate forbids it.
- Do not suppress lint rules with `//nolint` or `#[allow(...)]` unless the warning is genuinely a false positive — explain why if you do
- Fix the root cause, not the symptom (e.g. fix the logic, don't just cast away a type error)
- If a fix requires architectural changes beyond the scope of linting, surface it and ask before proceeding
- Loop until the linter reports zero issues
