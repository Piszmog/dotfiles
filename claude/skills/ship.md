---
name: ship
description: Run the full "ready to merge" pipeline — rebase, unit tests, E2E tests, lint, commit, push, and open a PR. Use when the user says "ship it", "ready to merge", or wants to finalize a branch for review.
---

Run the following sequence in order, stopping on any failure and reporting it:

1. **Rebase onto main** — fetch latest main and rebase the current branch.
   ```
   git fetch origin main
   git rebase origin/main
   ```
   If there are conflicts, report them and stop — do not auto-resolve.

2. **Unit tests with race detector**
   Run the project's unit test suite. Use the command from CLAUDE.md (typically `go test -race ./...`).
   Stop if any test fails.

3. **E2E tests**
   Run the full E2E suite. Use the command from CLAUDE.md (typically `go test -v ./... -tags=e2e`).
   Stop if any test fails.

4. **Lint**
   Run the linter. Use the command from CLAUDE.md (typically `golangci-lint run`).
   Fix any findings before continuing — do not proceed with lint failures.

5. **Commit** (if there are uncommitted changes)
   Stage specific files — never `git add -A` without reviewing.
   Write a commit with imperative mood subject line under 72 chars.
   Never skip pre-commit hooks.

6. **Push**
   Push the branch to the remote: `git push -u origin HEAD`
   Ask the user to confirm before pushing if this is the first push of the branch.

7. **Open PR**
   Use `gh pr create` with a title matching the commit subject and a body that:
   - Summarizes what changed
   - References the issue number (`Closes #N`) if one exists
   - Includes a test plan checklist

Report the PR URL when done.
