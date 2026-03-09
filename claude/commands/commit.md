Stage relevant changed files (never `git add -A`), write a commit with imperative mood subject under 72 chars, then push.

## Steps

1. Run `git status` and `git diff` to review all changes
2. Stage files individually — skip secrets, binaries, generated files unless intentional
3. Draft a commit message: imperative mood, <72 chars subject, no trailing period
4. Commit (never `--no-verify`)
5. Push with `-u origin <branch>` if no upstream set, otherwise `git push`

## Commit message format

```
<verb> <what> [in/for <where>]

- bullet of notable detail (optional)
- another detail (optional)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Never amend published commits. If a pre-commit hook fails, fix the issue and create a new commit.
