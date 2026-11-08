---
name: go
description: Go workflow using gopls through cclsp — diagnostics after every edit, go doc for exact APIs, targeted tests, and vulnerability checks. Use when working in a Go module or workspace (go.mod/go.work) or editing .go files.
---

# Go

Project commands win: if the repo has a `justfile`, `Makefile`, or `AGENTS.md` with its own
build/test/lint tasks, run those instead of the defaults below.

## Start of session

1. Run `go env GOMOD GOWORK` (bash). `/dev/null` with no `GOWORK` means neither a module nor a workspace; skip the rest of this skill.
2. Run `govulncheck ./...` only when you are about to change dependencies (`go get`, `go mod tidy`) or when the user asks. It is a network call and slow on a large repo, so it is not worth paying every session.
3. cclsp starts `gopls` at session start if it finds a `.go` file within three levels of the working directory, otherwise on the first call that touches one. Either way the first call can take several seconds; later calls are fast.

## Reading code

1. `find_workspace_symbols` (deferred: load it with `tool_search`) for a symbol when you do not know the file.
2. `find_definition` and `find_references` for navigation. Use `get_hover` for the type or doc comment at a position.
3. `go doc <pkg>.<Symbol>` (bash) for exact stdlib or module signatures. Do not guess field names or signatures — `go doc net/http.Request` costs one call.
4. `go doc -all <pkg>` for the public surface of a package, in this repo or a dependency.
5. `find_references` before renaming or changing the signature of a declaration, then `rename_symbol` (deferred). It edits files immediately — pass `dry_run: true` first.

## Editing code

1. Make all planned edits, including every reference you found.
2. The `lang-check` extension already runs `goimports` and `gopls check` after every `.go` edit and appends errors to the tool result. Read that instead of calling `get_diagnostics` again for the same file.
3. Call `get_diagnostics` when you need more than a single file: files you did not just edit, or workspace-wide analysis after a refactor. If it returns nothing on the first call, call it again — gopls publishes diagnostics asynchronously. cclsp roots gopls at the session directory, so a file outside it returns a `go list` warning ("not included in your workspace") instead of diagnostics — start the session at the module root, or fall back to `go build`.
4. If the edits touched `go.mod`/`go.sum`, run `govulncheck ./...` afterwards, then `go mod tidy`.
5. Never hand-edit `go.mod` requirements; use `go get`/`go mod tidy`.

## Testing

- Test only the packages you changed: `go test ./internal/server/...`, narrowing with `-run TestName` and `-count=1` while iterating.
- Add `-race` for anything touching goroutines, shared state, or HTTP handlers.
- Run `go test ./...` only when finishing a task or when the user asks — it is much slower.
- `gofmt -l <dir>` to find unformatted files you did not edit; `goimports` is what the post-edit check runs, and it also adds missing imports. For templ projects, run `templ generate` after editing `.templ` files.

## Fallbacks

If cclsp is unavailable, use `go build ./<pkg>`, `go vet ./<pkg>`, and the targeted test
command instead. Say that you fell back — do not silently skip the diagnostics step.
