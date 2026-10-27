import assert from "node:assert/strict";
import test from "node:test";
import { getPgSslConfig } from "../lib/db.pg.js";

test("local PostgreSQL may use plaintext for development", () => {
  assert.equal(getPgSslConfig("postgres://user:pass@localhost:5432/db"), false);
  assert.equal(getPgSslConfig("postgres://user:pass@127.0.0.1:5432/db", "0"), false);
});

test("remote PostgreSQL validates TLS certificates by default", () => {
  assert.deepEqual(getPgSslConfig("postgres://user:pass@db.example.com:5432/db"), { rejectUnauthorized: true });
});

test("PGSSL=0 cannot disable TLS for a remote database", () => {
  assert.throws(
    () => getPgSslConfig("postgres://user:pass@db.example.com:5432/db", "0"),
    /only for localhost PostgreSQL connections/,
  );
});

test("IPv6 loopback is treated as local", () => {
  assert.equal(getPgSslConfig("postgres://user:pass@[::1]:5432/db"), false);
});
