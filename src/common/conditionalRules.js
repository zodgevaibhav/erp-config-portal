// Pure helpers for the "conditional" transform_type: model <-> transform_params JSON, save-time validation
// (mirrors TransformParamsValidator in tm-platform-service-client-config) and a preview evaluator that
// mirrors apply_conditional() in transformation-svc/erp_transform/transform.py. No React / DOM here so it
// can be unit-tested with `node --test`.

export const MAX_RULES = 25;
export const MAX_GROUP_DEPTH = 2;
export const ROOT_PREFIX = "$root.";

export const OPERATORS = [
  { value: "equals", label: "equals", input: "text" },
  { value: "not_equals", label: "does not equal", input: "text" },
  { value: "contains", label: "contains", input: "text" },
  { value: "not_contains", label: "does not contain", input: "text" },
  { value: "starts_with", label: "starts with", input: "text" },
  { value: "ends_with", label: "ends with", input: "text" },
  { value: "in", label: "is one of (a, b, c)", input: "list" },
  { value: "not_in", label: "is not one of (a, b, c)", input: "list" },
  { value: "regex", label: "matches regex", input: "text" },
  { value: "gt", label: "is greater than", input: "number" },
  { value: "gte", label: "is at least", input: "number" },
  { value: "lt", label: "is less than", input: "number" },
  { value: "lte", label: "is at most", input: "number" },
  { value: "is_empty", label: "is empty", input: "none" },
  { value: "is_not_empty", label: "is not empty", input: "none" },
];
const OP_BY_VALUE = Object.fromEntries(OPERATORS.map((o) => [o.value, o]));

// ── editor model ─────────────────────────────────────────────────────────────
// model = { rules: [{ combine: "all"|"any", conds: [{path, op, value, ignoreCase}], then: Outcome }], otherwise: Outcome }
// Outcome = { mode: "value" | "passthrough" | "none", value: string }   ("none" only valid for otherwise)
export const emptyCondition = () => ({ path: "", op: "equals", value: "", ignoreCase: true });
export const emptyRule = () => ({ combine: "all", conds: [emptyCondition()], then: { mode: "value", value: "" } });
export const emptyModel = () => ({ rules: [], otherwise: { mode: "none", value: "" } });

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const outcomeFromJson = (raw) => {
  if (isPlainObject(raw) && raw.passthrough === true) return { mode: "passthrough", value: "" };
  return { mode: "value", value: raw === null || raw === undefined ? "" : String(raw) };
};
const outcomeToJson = (o) => (o.mode === "passthrough" ? { passthrough: true } : o.value);

const condFromJson = (c) => ({
  path: c.path || "",
  op: c.op,
  value: Array.isArray(c.value) ? c.value.join(", ") : (c.value === undefined || c.value === null ? "" : String(c.value)),
  ignoreCase: c.ignore_case !== false,
});

const condToJson = (c) => {
  const out = {};
  if (c.path && c.path.trim()) out.path = c.path.trim();
  out.op = c.op;
  const kind = OP_BY_VALUE[c.op]?.input;
  if (kind === "list") out.value = String(c.value).split(",").map((s) => s.trim()).filter((s) => s !== "");
  else if (kind === "number") out.value = c.value !== "" && !Number.isNaN(Number(c.value)) ? Number(c.value) : c.value;
  else if (kind !== "none") out.value = c.value;
  if (c.ignoreCase === false) out.ignore_case = false;
  return out;
};

const isLeaf = (n) => isPlainObject(n) && !("all" in n) && !("any" in n);

// JSON -> editor model. Returns { ok: true, model } or { ok: false, reason } where reason is a user-facing
// explanation (invalid JSON, or a structure only the JSON tab can represent, e.g. nested groups).
export const parseParams = (text) => {
  if (!text || !text.trim()) return { ok: true, model: emptyModel() };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, reason: `Not valid JSON: ${e.message}` }; }
  if (!isPlainObject(json) || !Array.isArray(json.rules)) return { ok: false, reason: "Expected an object with a \"rules\" array." };
  const rules = [];
  for (let i = 0; i < json.rules.length; i += 1) {
    const r = json.rules[i];
    if (!isPlainObject(r) || !isPlainObject(r.when)) return { ok: false, reason: `rules[${i}] needs a "when" object.` };
    let combine = "all";
    let leaves;
    if ("all" in r.when || "any" in r.when) {
      combine = "all" in r.when ? "all" : "any";
      leaves = r.when[combine];
      if (!Array.isArray(leaves) || !leaves.every(isLeaf)) return { ok: false, reason: `rules[${i}] uses nested groups -- edit it on the JSON tab.` };
    } else {
      leaves = [r.when];
    }
    rules.push({ combine, conds: leaves.map(condFromJson), then: outcomeFromJson(r.then) });
  }
  const otherwise = "else" in json ? outcomeFromJson(json.else) : { mode: "none", value: "" };
  return { ok: true, model: { rules, otherwise } };
};

export const serializeModel = (model) => {
  const rules = model.rules.map((r) => {
    const conds = r.conds.map(condToJson);
    const when = conds.length === 1 ? conds[0] : { [r.combine]: conds };
    return { when, then: outcomeToJson(r.then) };
  });
  const out = { rules };
  if (model.otherwise.mode !== "none") out.else = outcomeToJson(model.otherwise);
  return JSON.stringify(out);
};

// ── validation (same rules/messages shape as the Java validator) ─────────────
const isNumeric = (v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));

const validateOutcomeJson = (o, at, errors) => {
  if (o !== null && typeof o === "object") {
    const ok = isPlainObject(o) && Object.keys(o).length === 1 && typeof o.passthrough === "boolean";
    if (!ok) errors.push(`${at} must be a plain value or {"passthrough": true}`);
  }
};

const validateWhenJson = (node, at, depth, counter, errors) => {
  if (!isPlainObject(node)) { errors.push(`${at} must be an object`); return; }
  if ("all" in node || "any" in node) {
    if ("all" in node && "any" in node) { errors.push(`${at} cannot have both "all" and "any"`); return; }
    if (depth >= MAX_GROUP_DEPTH) { errors.push(`${at} nests groups deeper than ${MAX_GROUP_DEPTH} levels`); return; }
    const key = "all" in node ? "all" : "any";
    if (!Array.isArray(node[key]) || node[key].length === 0) { errors.push(`${at}.${key} must be a non-empty array`); return; }
    node[key].forEach((child, i) => validateWhenJson(child, `${at}.${key}[${i}]`, depth + 1, counter, errors));
    return;
  }
  counter.n += 1;
  if (counter.n === 21) errors.push(`${at} pushes the rule past 20 conditions`);
  const op = node.op;
  if (!OP_BY_VALUE[op]) { errors.push(`${at}.op must be one of ${OPERATORS.map((o) => o.value).join(", ")}${typeof op === "string" ? ` (got '${op}')` : ""}`); return; }
  if (node.path !== undefined && node.path !== null) {
    if (typeof node.path !== "string" || !node.path.trim()) errors.push(`${at}.path must be a non-blank string when present`);
    else {
      const rest = node.path.startsWith(ROOT_PREFIX) ? node.path.slice(ROOT_PREFIX.length) : node.path;
      if (!rest || rest.startsWith(".") || rest.endsWith(".") || rest.includes("..")) errors.push(`${at}.path '${node.path}' has an empty segment`);
    }
  }
  const kind = OP_BY_VALUE[op].input;
  if (kind === "none") return;
  const v = node.value;
  if (v === undefined || v === null || v === "" ) { errors.push(`${at}.value is required for op '${op}'`); return; }
  if (kind === "list" && (!Array.isArray(v) || v.length === 0)) errors.push(`${at}.value needs at least one entry for op '${op}'`);
  if (kind === "number" && !isNumeric(v)) errors.push(`${at}.value must be a number for op '${op}'`);
  if (op === "regex") {
    try { new RegExp(String(v)); } catch (e) { errors.push(`${at}.value is not a valid regex: ${e.message}`); }
  }
};

// Returns an array of human-readable problems ([] = valid).
export const validateParams = (text) => {
  if (!text || !text.trim()) return ["Add at least one rule."];
  let json;
  try { json = JSON.parse(text); } catch (e) { return [`Not valid JSON: ${e.message}`]; }
  if (!isPlainObject(json)) return ["transform_params must be a JSON object with a \"rules\" array."];
  if (!Array.isArray(json.rules) || json.rules.length === 0) return ["Add at least one rule."];
  const errors = [];
  if (json.rules.length > MAX_RULES) errors.push(`rules has ${json.rules.length} entries; the maximum is ${MAX_RULES}`);
  json.rules.forEach((r, i) => {
    const at = `rules[${i}]`;
    if (!isPlainObject(r)) { errors.push(`${at} must be an object with "when" and "then"`); return; }
    if (!("when" in r)) errors.push(`${at}.when is required`);
    else validateWhenJson(r.when, `${at}.when`, 0, { n: 0 }, errors);
    if (!("then" in r)) errors.push(`${at}.then is required`);
    else validateOutcomeJson(r.then, `${at}.then`, errors);
  });
  if ("else" in json) validateOutcomeJson(json.else, "else", errors);
  return errors;
};

// ── preview evaluator (mirror of apply_conditional) ──────────────────────────
const norm = (v, ignoreCase) => {
  if (v === undefined || v === null) return null;
  const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  return ignoreCase ? s.toLowerCase() : s;
};
const toNumber = (v) => {
  if (v === undefined || v === null || typeof v === "boolean") return null;
  const n = Number(v);
  return v === "" || Number.isNaN(n) ? null : n;
};
const isEmptyValue = (v) => {
  if (typeof v === "string") return v.trim() === "";
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
};

const evalCondition = (c, own, scope, root, getPath) => {
  if (!OP_BY_VALUE[c.op]) throw new Error(`Unsupported conditional op: ${c.op}`);
  let actual;
  if (!c.path) actual = own;
  else if (c.path.startsWith(ROOT_PREFIX)) actual = getPath(root ?? scope, c.path.slice(ROOT_PREFIX.length));
  else actual = getPath(scope, c.path);
  if (c.op === "is_empty") return isEmptyValue(actual);
  if (c.op === "is_not_empty") return !isEmptyValue(actual);

  const ic = c.ignore_case !== false;
  const a = norm(actual, ic);
  if (["gt", "gte", "lt", "lte"].includes(c.op)) {
    const l = toNumber(actual); const r = toNumber(c.value);
    if (l === null || r === null) return false;
    return { gt: l > r, gte: l >= r, lt: l < r, lte: l <= r }[c.op];
  }
  if (c.op === "in" || c.op === "not_in") {
    const options = Array.isArray(c.value) ? c.value : [c.value];
    const hit = a !== null && options.map((o) => norm(o, ic)).includes(a);
    return c.op === "in" ? hit : !hit;
  }
  const e = norm(c.value, ic);
  switch (c.op) {
    case "equals": return a !== null && a === e;
    case "not_equals": return a === null || a !== e;
    case "contains": return a !== null && e !== null && a.includes(e);
    case "not_contains": return a === null || e === null || !a.includes(e);
    case "starts_with": return a !== null && e !== null && a.startsWith(e);
    case "ends_with": return a !== null && e !== null && a.endsWith(e);
    default: { // regex
      if (a === null || e === null) return false;
      return new RegExp(String(c.value), ic ? "i" : "").test(norm(actual, false));
    }
  }
};

const evalWhen = (node, own, scope, root, getPath, depth = 0) => {
  if (depth > 5) throw new Error("conditional rule nesting too deep");
  if (!isPlainObject(node)) throw new Error("conditional 'when' must be an object");
  for (const [key, combine] of [["all", "every"], ["any", "some"]]) {
    if (key in node) {
      if (!Array.isArray(node[key]) || node[key].length === 0) throw new Error(`conditional '${key}' must be a non-empty list`);
      return node[key][combine]((c) => evalWhen(c, own, scope, root, getPath, depth + 1));
    }
  }
  return evalCondition(node, own, scope, root, getPath);
};

const resolveOutcome = (o, own) => (isPlainObject(o) && o.passthrough ? own : o);

// Returns { value, matched } where matched is the index of the winning rule, "else", or null (no rule, no else).
// `getPath(obj, dottedPath)` is injected so the host can reuse its own path resolver. Never throws:
// an invalid/in-progress rule set yields { error } so a half-edited rule doesn't break the preview.
export const evaluateConditional = (text, own, scope, root, getPath, defaultValue = null) => {
  try {
    const json = JSON.parse(text || "{}");
    if (!Array.isArray(json.rules)) return { error: "No rules yet." };
    for (let i = 0; i < json.rules.length; i += 1) {
      const rule = json.rules[i];
      if (evalWhen(rule.when, own, scope, root, getPath)) return { value: resolveOutcome(rule.then, own), matched: i };
    }
    if ("else" in json) return { value: resolveOutcome(json.else, own), matched: "else" };
    return { value: defaultValue, matched: null };
  } catch (e) {
    return { error: e.message };
  }
};

// One-line summary for a collapsed rule card: IF type contains Gov AND region equals US → GOV_US
export const summarizeRule = (rule) => {
  const label = (c) => `${c.path || "this field"} ${OP_BY_VALUE[c.op]?.label ?? c.op}${OP_BY_VALUE[c.op]?.input === "none" ? "" : ` ${c.value === "" ? "…" : c.value}`}`;
  const joiner = rule.combine === "any" ? " OR " : " AND ";
  const then = rule.then.mode === "passthrough" ? "keep original" : (rule.then.value === "" ? "…" : rule.then.value);
  return `IF ${rule.conds.map(label).join(joiner)} → ${then}`;
};

// Candidate source paths for the autocomplete list, from a sample JSON object (objects only; for arrays the
// first element's keys are offered, which is what array-group mappings use since paths are item-relative).
export const suggestPaths = (sample, limit = 200) => {
  const out = new Set();
  const walk = (node, prefix, depth) => {
    if (out.size >= limit || depth > 6) return;
    if (Array.isArray(node)) { if (node.length && isPlainObject(node[0])) walk(node[0], prefix, depth + 1); return; }
    if (!isPlainObject(node)) return;
    Object.entries(node).forEach(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!isPlainObject(v) && !Array.isArray(v)) out.add(k.includes(".") ? p.replace(k, k.replace(/\./g, "\\.")) : p);
      walk(v, p, depth + 1);
    });
  };
  walk(sample, "", 0);
  return [...out];
};
