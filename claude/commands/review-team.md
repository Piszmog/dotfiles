Spawn four parallel reviewers on the current branch diff, then consolidate their findings into a prioritized issue list.

## Steps

1. Get the diff: `git diff main...HEAD` (or against the merge base)
2. Summarize the changeset: files changed, lines added/removed, rough scope
3. Spawn four reviewers in parallel, each with the full diff and codebase context:

### Reviewer personas

**Go idioms reviewer**
- Focus: idiomatic Go, error handling patterns, naming conventions, unnecessary complexity, missing context propagation, goroutine leaks, interface misuse

**Security reviewer**
- Focus: SQL injection, unvalidated input, missing auth checks, insecure defaults, secrets in code, OWASP Top 10 relevant to the stack (Go/HTMX/SQLite)

**Frontend/HTMX reviewer**
- Focus: templ correctness, HTMX attribute usage, accessibility, form handling, XSS vectors in templates, CSS/Tailwind consistency

**Devil's advocate**
- Focus: design decisions, over-engineering, missing edge cases, assumptions that could break, what happens when this feature scales or is misused

4. Collect all findings and deduplicate
5. Output a prioritized list:
   - **P0 – Blockers** (must fix before merge)
   - **P1 – Should fix** (significant issues)
   - **P2 – Nice to fix** (style, minor improvements)
   - **P3 – Future consideration** (out of scope but worth noting)

## Notes

- Each reviewer is an independent subagent with no shared state
- If no changes exist against main, ask the user to specify a base ref
- Skip personas that are not relevant (e.g. no frontend changes → skip frontend reviewer)
