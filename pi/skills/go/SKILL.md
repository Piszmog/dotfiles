---
name: go
description: Go workflow using gopls tools — workspace discovery, symbol/reference navigation, diagnostics after every edit, go doc for exact APIs, targeted tests, and vulnerability checks. Use when working in a Go module or workspace (go.mod/go.work) or editing .go files.
---

# Go

Project commands win: if the repo has a `justfile`, `Makefile`, or `AGENTS.md` with its own
build/test/lint tasks, run those instead of the defaults below.

## Start of session

1. Call `go_workspace` to learn whether this is a module, a workspace, or GOPATH project. If it is not a Go workspace, skip the rest of this skill.
2. Run `go_vulncheck` only when you are about to change dependencies (`go get`, `go mod tidy`) or when the user asks. It is a network call and `./...` on a large repo is slow, so it is not worth paying on every session.
3. `gopls` may ask for a vulnerability check at session start. Skip it unless dependencies changed — that instruction is written for a session that has no other source of truth.

## Reading code

1. `go_search` for a symbol when you do not know the file (fuzzy, cheaper than grep for identifiers).
2. Immediately after reading any `.go` file for the first time, call `go_file_context` on it to see the same-package declarations it depends on.
3. `go_package_api` for the public surface of another package, in this repo or a dependency.
4. `go doc <pkg>.<Symbol>` (bash) for exact stdlib or module signatures. Do not guess field names or signatures — `go doc net/http.Request` costs one call.
5. `go_symbol_references` before renaming or changing the signature of a declaration.

## Editing code

1. Make all planned edits, including every reference you found.
2. The `lang-check` extension already runs `goimports` and `gopls check` after every `.go` edit and appends errors to the tool result. Read that instead of calling `go_diagnostics` again for the same file.
3. Call `go_diagnostics` when you need more than a single file: files you did not just edit, workspace-wide analysis after a refactor, or suggested fixes for a diagnostic. Apply the fixes it offers when correct, then re-run it to confirm.
4. If the edits touched `go.mod`/`go.sum`, run `go_vulncheck` on `./...` afterwards, then `go mod tidy`.
5. Never hand-edit `go.mod` requirements; use `go get`/`go mod tidy`.

## Testing

- Test only the packages you changed: `go test ./internal/server/...`, narrowing with `-run TestName` and `-count=1` while iterating.
- Add `-race` for anything touching goroutines, shared state, or HTTP handlers.
- Run `go test ./...` only when finishing a task or when the user asks — it is much slower.
- `gofmt -l <dir>` to find unformatted files you did not edit; `goimports` is what the post-edit check runs, and it also adds missing imports. For templ projects, run `templ generate` after editing `.templ` files.

## Fallbacks

If the gopls tools are unavailable, use `go build ./<pkg>`, `go vet ./<pkg>`, and the targeted
test command instead. Say that you fell back — do not silently skip the diagnostics step.
