Stage relevant changed files (never `git add -A`), write a commit with imperative mood subject under 72 chars, push the branch, then open a PR using `gh pr create`.

## Steps

1. Run `git status` and `git diff` to review all changes
2. Stage files individually — skip secrets, binaries, generated files unless intentional
3. Draft a commit message: imperative mood, <72 chars subject, no trailing period
4. Commit (never `--no-verify`)
5. Push with `-u origin <branch>` if no upstream set, otherwise `git push`
6. Create a PR with `gh pr create` — title matches commit subject, body summarizes what changed and references the issue number if one is in context

## Flags

- `--no-pr`: stop after push, skip PR creation
- `--draft`: open PR as draft

## Commit message format

```
<verb> <what> [in/for <where>]

- bullet of notable detail (optional)
- another detail (optional)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Never amend published commits. If a pre-commit hook fails, fix the issue and create a new commit.
