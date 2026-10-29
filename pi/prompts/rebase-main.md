---
description: Rebase the current branch onto latest main and verify
argument-hint: "[--push]"
---
Fetch latest main, rebase the current branch onto it, then run tests to confirm nothing broke.

## Steps

1. Confirm the current branch is not `main` or `master` — refuse if so
2. `git fetch origin main`
3. `git rebase origin/main`
4. If conflicts arise:
   - Show each conflicting file and the conflict diff
   - Resolve trivial conflicts (whitespace, import ordering) automatically
   - For non-trivial conflicts, pause and ask the user which version to keep
5. After clean rebase, run the project's build or type-check to confirm it compiles (`go build ./...`, `cargo check`, `npm run build`, or the project's own task)
6. Run unit tests via `/test-all --unit`
7. Report the result: commits rebased, any conflicts resolved, test status

## Notes

- Never force-push to main/master
- If `--push` flag is passed, force-push the rebased branch to its remote tracking branch after success (`git push --force-with-lease`)
- If rebase fails and cannot be automatically resolved, run `git rebase --abort` and report the conflicting files
