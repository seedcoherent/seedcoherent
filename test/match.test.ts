import assert from "node:assert/strict";
import { test } from "node:test";
import { norm, tokenize, ctxFor, has, tok, or } from "../src/match.js";

test("norm lowercases and strips underscores, hyphens, and spaces", () => {
  assert.equal(norm("first_name"), "firstname");
  assert.equal(norm("LAST-NAME"), "lastname");
  assert.equal(norm("Zip Code"), "zipcode");
  assert.equal(norm("already"), "already");
});

test("norm collapses multiple separators", () => {
  assert.equal(norm("a__b--c"), "abc");
});

test("tokenize splits on underscores and hyphens", () => {
  assert.deepEqual(tokenize("first_name"), ["first", "name"]);
  assert.deepEqual(tokenize("last-name"), ["last", "name"]);
});

test("tokenize splits on camelCase boundaries", () => {
  assert.deepEqual(tokenize("firstName"), ["first", "name"]);
  assert.deepEqual(tokenize("shippingCity"), ["shipping", "city"]);
});

test("tokenize lowercases all tokens", () => {
  assert.deepEqual(tokenize("UserID"), ["user", "id"]);
});

test("tokenize filters empty segments", () => {
  assert.deepEqual(tokenize("__foo__"), ["foo"]);
});

test("ctxFor returns normalized name and token list", () => {
  const ctx = ctxFor("shippingCity");
  assert.equal(ctx.n, "shippingcity");
  assert.deepEqual(ctx.tokens, ["shipping", "city"]);
});

test("has matches a substring in the normalized name", () => {
  const ctx = ctxFor("email_address");
  assert.ok(has("email")(ctx));
  assert.ok(has("address")(ctx));
});

test("has returns false when fragment is absent", () => {
  const ctx = ctxFor("user_id");
  assert.ok(!has("email")(ctx));
});

test("has accepts multiple fragments and returns true if any match", () => {
  const ctx = ctxFor("phone_number");
  assert.ok(has("email", "phone")(ctx));
});

test("tok matches a whole token", () => {
  const ctx = ctxFor("user_id");
  assert.ok(tok("id")(ctx));
  assert.ok(tok("user")(ctx));
});

test("tok rejects substring-only matches that are not whole tokens", () => {
  // "ip" should not match "zip" as a whole token
  const ctx = ctxFor("zip_code");
  assert.ok(!tok("ip")(ctx));
});

test("tok accepts multiple names and returns true if any token matches", () => {
  const ctx = ctxFor("latitude");
  assert.ok(tok("lat", "latitude")(ctx));
});

test("or returns true when any matcher matches", () => {
  const ctx = ctxFor("email");
  const matcher = or(tok("phone"), has("email"));
  assert.ok(matcher(ctx));
});

test("or returns false when no matcher matches", () => {
  const ctx = ctxFor("quantity");
  const matcher = or(tok("phone"), has("email"));
  assert.ok(!matcher(ctx));
});

test("or short-circuits: first match wins", () => {
  const ctx = ctxFor("email");
  let secondCalled = false;
  const second = (c: typeof ctx) => {
    secondCalled = true;
    return has("email")(c);
  };
  or(has("email"), second)(ctx);
  assert.ok(!secondCalled);
});
