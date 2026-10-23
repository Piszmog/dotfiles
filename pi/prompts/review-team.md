---
description: Multi-persona review of the current branch diff
argument-hint: "[base-ref]"
---
Review the current branch diff from four perspectives in one pass, then consolidate the findings into a prioritized list.

## Steps

1. Get the diff: `git diff $(git merge-base HEAD ${1:-origin/main})...HEAD`
2. Summarize the changeset: files changed, lines added/removed, rough scope
3. Review the diff from each relevant perspective:

### Personas

**Go/Rust idioms**
- Focus: idiomatic code, error handling patterns, naming conventions, unnecessary complexity, missing context propagation, goroutine leaks, interface misuse

**Security**
- Focus: injection (SQL/command/path), unvalidated input, missing auth checks, insecure defaults, secrets in code, OWASP Top 10 relevant to Go/templ/HTMX/SQLite

**Frontend/HTMX**
- Focus: templ correctness, HTMX attribute usage, accessibility, form handling, XSS vectors in templates, CSS/Tailwind consistency

**Devil's advocate**
- Focus: design decisions, over-engineering, missing edge cases, assumptions that could break, scaling or misuse risks

4. Deduplicate findings and output a prioritized list:
   - **P0 – Blockers** (must fix before merge)
   - **P1 – Should fix** (significant issues)
   - **P2 – Nice to fix** (style, minor improvements)
   - **P3 – Future consideration** (out of scope but worth noting)

5. End with: "X blockers, Y should-fix, Z nice-to-fix, W future items."

## Notes

- Skip personas that are not relevant (e.g. no frontend changes → skip the frontend reviewer)
- If no changes exist against the base ref, ask the user to specify one
- This runs inline. Pi's subagent extension is not installed, so do not claim to spawn parallel reviewers.
