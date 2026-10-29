---
name: rust
description: Rust workflow — workspace and MSRV discovery, rust-analyzer navigation via cclsp, post-edit diagnostics from the lang-check extension, targeted cargo test, and clippy/fmt gates. Use when working in a crate or Cargo workspace (Cargo.toml/Cargo.lock) or editing .rs files.
---

# Rust

Project commands win: if the repo has a `justfile`, `Makefile`, or `AGENTS.md` with its own
build/test/lint tasks, run those instead of the defaults below.

## Start of session

1. `cargo locate-project --workspace --message-format plain` for the workspace root. Run cargo from
   there; a subdirectory changes what `-p`, `cargo test`, and rust-analyzer consider in scope.
2. Read `rust-toolchain.toml` (or `rustup show`), `Cargo.toml` `[workspace.package]`/`[package]`
   `edition` and `rust-version`, and any `[lints]`/`clippy.toml`. `rust-version` is the MSRV — do not
   reach for newer stdlib APIs than it allows.

## Reading code

1. `find_workspace_symbols` when you do not know the file; `find_definition` / `find_references`
   before changing a signature or a trait impl.
2. `get_hover` for signatures and docs instead of guessing. It is the Rust equivalent of `go doc`.
3. `get_diagnostics` is advisory only: cclsp pulls diagnostics and returns an empty list when its
   per-file cache is cold, so a clean answer is not proof the file compiles. The post-edit
   `[lang-check]` output is the authoritative signal.
4. `cargo tree -i <crate>` to see why a dependency is present; `cargo tree -e features` before
   touching feature-gated code. Code behind an unenabled feature looks dead but is not.

## Editing code

1. The `lang-check` extension already runs `rustfmt` and `cargo check --all-targets` after every
   `.rs` edit and appends failures to the tool result. Do not re-run `cargo check` by hand after a
   single-file edit; read the appended diagnostics and fix them.
2. `--all-targets` matters: plain `cargo check` does not type-check `tests/`, `benches/`, or
   `#[cfg(test)]` modules, so test-code errors are invisible without it.
3. Borrow-checker errors: fix the ownership root cause. Do not add `.clone()` or `Rc<RefCell<_>>`
   to silence the compiler unless the design genuinely needs shared ownership — say so if it does.
4. Unresolved imports have no automatic fix here: cclsp exposes no code actions, so
   `rust-analyzer`'s import-insertion quick fixes are unavailable. Find the real path with
   `find_workspace_symbols` or `cargo tree`, then write the `use` yourself.
5. Never hand-edit `Cargo.lock` or anything under `target/`. Use `cargo add`/`cargo remove` for
   dependencies, and re-run the check after `Cargo.toml` changes.

## Testing

- `cargo test -p <crate> --lib <name>` while iterating; `--test <integration>` for `tests/`.
- Doctests are skipped by `--lib`: run `cargo test -p <crate> --doc` when you changed doc examples.
- `cargo nextest` is not installed on this machine; do not reference it.
- `cargo test --all-targets` only when finishing a task or when asked.

## Lint and format

- `cargo fmt` (already applied per edit by `lang-check`); `cargo fmt --check` in CI.
- `cargo clippy --all-targets -- -D warnings` before declaring a task done. With `[lints]` set to
  `pedantic`/`deny`, expect a large set: fix findings in the files you changed, do not refactor
  unrelated code, and never add `unsafe` to silence a lint in a crate that forbids it.
- `#[allow(...)]` only for a genuine false positive, with a comment explaining why.

## Fallbacks

If cclsp is unavailable, use `grep` for identifiers and `cargo check --all-targets` for
diagnostics. Say that you fell back — do not silently skip the check.
