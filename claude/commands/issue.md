Fetch a GitHub issue by number, load its full context, then enter plan mode to design an implementation.

## Usage

```
/issue <N>
```

## Steps

1. Run `gh issue view <N> --json number,title,body,comments,labels,assignees` and parse the output
2. Display a brief summary: title, labels, description
3. Read the issue body and all comments to extract:
   - Acceptance criteria / definition of done
   - Constraints or design decisions already made
   - Related issues or PRs mentioned
4. Identify affected areas of the codebase from context clues in the issue
5. Enter plan mode and produce an implementation plan covering:
   - Files to create or modify
   - Database migrations needed (if any)
   - New tests required
   - Potential gotchas or blockers

## Notes

- If no issue number is provided, ask for one before proceeding
- If `gh` is not authenticated or the repo can't be detected, surface the error immediately
- The plan should be grounded in the actual codebase — read relevant files before proposing changes
- Reference the issue number in all subsequent commits and the PR body
