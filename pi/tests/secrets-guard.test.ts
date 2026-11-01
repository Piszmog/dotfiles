/**
 * Tests for the secrets-guard extension. Run from the pi config directory:
 *
 *   node --test 'tests/*.test.ts'
 *
 * The guard is a deny rule, so the important cases are the ones that must stay readable:
 * `.env.example` and ordinary source files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashReadsSecret, isProtectedPath } from "../extensions/secrets-guard.ts";

const cwd = mkdtempSync(join(tmpdir(), "pi-secrets-"));

test("env files are protected", () => {
	assert.ok(isProtectedPath(".env", cwd));
	assert.ok(isProtectedPath(".env.local", cwd));
	assert.ok(isProtectedPath("app/.env.production", cwd));
	assert.ok(isProtectedPath(".envrc", cwd));
});

test("env templates stay readable", () => {
	assert.ok(!isProtectedPath(".env.example", cwd));
	assert.ok(!isProtectedPath(".env.sample", cwd));
	assert.ok(!isProtectedPath(".env.template", cwd));
	assert.ok(!isProtectedPath(".env.dist", cwd));
});

test("secrets files and directories are protected", () => {
	assert.ok(isProtectedPath("secrets/terraform.tfvars", cwd));
	assert.ok(isProtectedPath("secrets.yml", cwd));
	assert.ok(isProtectedPath(".secrets/token", cwd));
	assert.ok(isProtectedPath("config/.secrets.json", cwd));
});

test("ssh and gnupg material is protected", () => {
	assert.ok(isProtectedPath("~/.ssh/id_ed25519", cwd));
	assert.ok(isProtectedPath("~/.ssh/config", cwd));
	assert.ok(isProtectedPath(".ssh/known_hosts", cwd));
	assert.ok(isProtectedPath("~/.gnupg/private-keys-v1.d/x.key", cwd));
	assert.ok(isProtectedPath(".gnupg/trustdb.gpg", cwd));
});

test("ordinary files are not protected", () => {
	assert.ok(!isProtectedPath("src/main.go", cwd));
	assert.ok(!isProtectedPath("internal/secrets_test.go", cwd));
	assert.ok(!isProtectedPath("app.environment.go", cwd));
});

test("shell commands that print secrets are blocked", () => {
	assert.ok(bashReadsSecret("cat ~/.ssh/config", cwd));
	assert.ok(bashReadsSecret("cat .env", cwd));
	assert.ok(bashReadsSecret("head -5 app/.env.local", cwd));
	assert.ok(bashReadsSecret("rg TOKEN .env", cwd));
	assert.ok(bashReadsSecret("cat secrets/prod.yml", cwd));
});

test("shell commands without secrets are allowed", () => {
	assert.ok(!bashReadsSecret("echo hello", cwd));
	assert.ok(!bashReadsSecret("cat .env.example", cwd));
	assert.ok(!bashReadsSecret("git status", cwd));
	assert.ok(!bashReadsSecret("go test ./...", cwd));
});
