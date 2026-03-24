Fetch a GitHub issue by number, load its full context, then enter plan mode to design an implementation. Use ultrathink for analysis and planning.

## Usage

```
/issue <N>
```

## Steps

1. Run `gh issue view <N> --json number,title,body,comments,labels,assignees,milestone,projectItems` and parse the output
2. Display a brief summary: title, labels, milestone, description
3. Read the issue body and all comments to extract:
   - Acceptance criteria / definition of done
   - Constraints or design decisions already made
   - Related issues or PRs mentioned (capture their numbers)
4. Fetch each related issue/PR found in step 3:
   - Issues: `gh issue view <N> --json number,title,body,state`
   - PRs: `gh pr view <N> --json number,title,body,state,mergedAt`
5. Identify affected areas of the codebase from context clues in the issue
6. Enter plan mode and produce an implementation plan covering:
   - Files to create or modify
   - Database migrations needed (if any)
   - New tests required
   - Potential gotchas or blockers

## Notes

- If no issue number is provided, ask for one before proceeding
- If `gh` is not authenticated or the repo can't be detected, surface the error immediately
- The plan should be grounded in the actual codebase — read relevant files before proposing changes
- Reference the issue number in all subsequent commits and the PR body
