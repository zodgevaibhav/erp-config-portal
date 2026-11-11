import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyRule, emptyModel, parseParams, serializeModel, validateParams, evaluateConditional, summarizeRule, suggestPaths, MAX_RULES,
} from "./conditionalRules.js";

const get = (obj, path) => path.split(".").reduce((n, k) => (n && typeof n === "object" && k in n ? n[k] : undefined), obj);
const run = (params, own, scope = {}, root = scope) => evaluateConditional(JSON.stringify(params), own, scope, root, get);

const multi = {
  rules: [{
    when: { all: [
      { path: "a", op: "equals", value: "b" },
      { path: "c", op: "contains", value: "d" },
      { any: [{ path: "e", op: "equals", value: "f" }, { path: "e", op: "is_empty" }] },
    ] },
    then: "h",
  }],
  else: "i",
};

test("evaluates AND/OR groups and else", () => {
  assert.equal(run(multi, undefined, { a: "b", c: "xdx", e: "f" }).value, "h");
  assert.equal(run(multi, undefined, { a: "b", c: "xdx", e: "" }).value, "h");
  const miss = run(multi, undefined, { a: "zzz", c: "xdx", e: "f" });
  assert.deepEqual([miss.value, miss.matched], ["i", "else"]);
});

test("first match wins, passthrough, missing else", () => {
  const p = { rules: [{ when: { op: "contains", value: "gov" }, then: "G" }, { when: { op: "contains", value: "g" }, then: "OTHER" }] };
  assert.deepEqual(run(p, "US Government"), { value: "G", matched: 0 });
  assert.deepEqual(run(p, "zzz"), { value: null, matched: null });
  assert.equal(run({ ...p, else: { passthrough: true } }, "keep").value, "keep");
});

test("operators, case handling and nulls mirror the engine", () => {
  const one = (op, value, actual, extra = {}) => run({ rules: [{ when: { op, ...(value === undefined ? {} : { value }), ...extra }, then: "HIT" }], else: "MISS" }, actual).value === "HIT";
  assert.ok(one("equals", "ABC", "abc"));
  assert.ok(!one("equals", "ABC", "abc", { ignore_case: false }));
  assert.ok(one("in", ["a", "b"], "B"));
  assert.ok(one("not_in", ["a"], "c"));
  assert.ok(one("regex", "^\\d{3}$", "123"));
  assert.ok(!one("regex", "^\\d{3}$", "12a"));
  assert.ok(one("gt", 5, "10"));
  assert.ok(!one("lt", 5, "10"));
  assert.ok(!one("lte", 10, "x"));
  assert.ok(one("is_empty", undefined, "  "));
  assert.ok(one("is_empty", undefined, undefined));
  assert.ok(!one("equals", "a", undefined));
  assert.ok(one("not_equals", "a", undefined));
  assert.ok(one("equals", "true", true));
});

test("$root paths and own-value + other-field conditions", () => {
  const p = { rules: [{ when: { all: [{ path: "qty", op: "gt", value: 2 }, { path: "$root.customer.type", op: "equals", value: "GOV" }] }, then: "BULK" }], else: "STD" };
  const root = { customer: { type: "GOV" } };
  assert.equal(run(p, undefined, { qty: 5 }, root).value, "BULK");
  assert.equal(run(p, undefined, { qty: 1 }, root).value, "STD");
});

test("bad ops are reported, not thrown", () => {
  assert.match(run({ rules: [{ when: { op: "contain", value: "a" }, then: "A" }] }, "a").error, /Unsupported conditional op/);
});

test("model <-> JSON round trip keeps flat rules", () => {
  const rule = emptyRule();
  rule.conds = [{ path: "type", op: "contains", value: "Gov", ignoreCase: true }, { path: "region", op: "in", value: "US, CA", ignoreCase: false }];
  rule.then.value = "GOV";
  const model = { rules: [rule, { combine: "any", conds: [{ path: "", op: "gt", value: "5", ignoreCase: true }], then: { mode: "passthrough", value: "" } }], otherwise: { mode: "value", value: "OTHER" } };
  const text = serializeModel(model);
  const json = JSON.parse(text);
  assert.deepEqual(json.rules[0].when.all[1], { path: "region", op: "in", value: ["US", "CA"], ignore_case: false });
  assert.deepEqual(json.rules[1], { when: { op: "gt", value: 5 }, then: { passthrough: true } });
  assert.equal(json.else, "OTHER");
  const back = parseParams(text);
  assert.ok(back.ok);
  assert.equal(serializeModel(back.model), text);
  assert.equal(validateParams(text).length, 0);
});

test("empty text parses to an empty model; nested groups are JSON-tab only", () => {
  assert.deepEqual(parseParams("").model, emptyModel());
  const nested = parseParams(JSON.stringify(multi));
  assert.equal(nested.ok, false);
  assert.match(nested.reason, /nested groups/);
  assert.equal(parseParams("{oops").ok, false);
});

test("validation mirrors the API (located messages)", () => {
  assert.deepEqual(validateParams(""), ["Add at least one rule."]);
  assert.match(validateParams("{oops")[0], /Not valid JSON/);
  const op = validateParams(JSON.stringify({ rules: [{ when: { all: [{ op: "equals", value: "x" }, { op: "contain", value: "y" }] }, then: "z" }] }));
  assert.match(op[0], /rules\[0\]\.when\.all\[1\]\.op/);
  assert.match(validateParams(JSON.stringify({ rules: [{ when: { op: "equals" }, then: "x" }] }))[0], /value is required/);
  assert.match(validateParams(JSON.stringify({ rules: [{ when: { op: "regex", value: "(" }, then: "x" }] }))[0], /valid regex/);
  assert.match(validateParams(JSON.stringify({ rules: [{ when: { op: "is_empty", path: "a..b" }, then: "x" }] }))[0], /empty segment/);
  assert.match(validateParams(JSON.stringify({ rules: [{ when: { all: [{ any: [{ all: [{ op: "is_empty" }] }] }] }, then: "x" }] }))[0], /deeper than/);
  assert.match(validateParams(JSON.stringify({ rules: [{ when: { op: "is_empty" }, then: { x: 1 } }] }))[0], /\.then/);
  const many = { rules: Array.from({ length: MAX_RULES + 1 }, () => ({ when: { op: "is_empty" }, then: "x" })) };
  assert.match(validateParams(JSON.stringify(many))[0], /maximum/);
});

test("summaries and path suggestions", () => {
  const r = emptyRule();
  r.conds = [{ path: "type", op: "contains", value: "Gov", ignoreCase: true }, { path: "region", op: "equals", value: "US", ignoreCase: true }];
  r.then.value = "GOV_US";
  assert.equal(summarizeRule(r), "IF type contains Gov AND region equals US → GOV_US");
  assert.deepEqual(suggestPaths({ a: 1, b: { c: 2 }, lines: [{ sku: "x" }] }).sort(), ["a", "b.c", "lines.sku"]);
});
