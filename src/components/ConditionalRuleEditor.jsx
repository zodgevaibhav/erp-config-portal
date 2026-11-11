import { useMemo, useState } from "react";
import {
  OPERATORS, MAX_RULES, emptyRule, parseParams, serializeModel, validateParams, summarizeRule, suggestPaths,
} from "../common/conditionalRules.js";

const inputCls = "rounded-2xl border border-outline bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10";
const smallBtn = "rounded-full p-1 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent";

const OutcomeInput = ({ outcome, onChange, allowEmpty, label }) => (
  <div className="flex flex-wrap items-center gap-2">
    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
    <select value={outcome.mode} onChange={(e) => onChange({ ...outcome, mode: e.target.value })} className={inputCls}>
      <option value="value">Set value</option>
      <option value="passthrough">Keep original value</option>
      {allowEmpty && <option value="none">Use default / leave empty</option>}
    </select>
    {outcome.mode === "value" && (
      <input value={outcome.value} onChange={(e) => onChange({ ...outcome, value: e.target.value })}
        placeholder="output value" className={`${inputCls} min-w-0 flex-1`} />
    )}
  </div>
);

/**
 * Visual editor for a "conditional" rule's transform_params. `value` is the params JSON string (the single
 * source of truth); every edit calls onChange(newJsonString). Table tab = rule builder; JSON tab = raw edit
 * (also the only place nested AND/OR groups can be edited).
 *   getSample(): { own, scope, root } for the live test panel, or null
 *   evaluate(paramsText, own, scope, root): { value, matched } | { error }
 *   sampleSource: object used only for path autocomplete
 */
export default function ConditionalRuleEditor({ value, onChange, getSample, evaluate, sampleSource }) {
  const [tab, setTab] = useState("table");
  const [openIdx, setOpenIdx] = useState(0);
  const parsed = useMemo(() => parseParams(value), [value]);
  const errors = useMemo(() => validateParams(value), [value]);
  const paths = useMemo(() => suggestPaths(sampleSource || {}), [sampleSource]);
  const datalistId = useMemo(() => `cond-paths-${Math.random().toString(36).slice(2, 8)}`, []);
  const sample = getSample ? getSample() : null;
  const result = sample && evaluate ? evaluate(value, sample.own, sample.scope, sample.root) : null;

  const tableOk = parsed.ok;
  const activeTab = tableOk ? tab : "json";
  const model = parsed.ok ? parsed.model : null;
  const commit = (next) => onChange(serializeModel(next));
  const updateRule = (i, patch) => commit({ ...model, rules: model.rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const updateCond = (i, j, patch) => updateRule(i, { conds: model.rules[i].conds.map((c, k) => (k === j ? { ...c, ...patch } : c)) });
  const moveRule = (i, d) => {
    const rules = [...model.rules];
    [rules[i], rules[i + d]] = [rules[i + d], rules[i]];
    setOpenIdx(i + d);
    commit({ ...model, rules });
  };

  return (
    <div className="rounded-2xl border border-outline-variant bg-white p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase text-slate-500">
          Conditional rules{tableOk ? ` · ${model.rules.length} of ${MAX_RULES}` : ""}
        </span>
        <div className="inline-flex rounded-full bg-slate-100 p-0.5 text-[10px] font-semibold">
          {["table", "json"].map((t) => (
            <button key={t} type="button" disabled={t === "table" && !tableOk} onClick={() => setTab(t)}
              className={`rounded-full px-2.5 py-1 capitalize ${activeTab === t ? "bg-white text-primary shadow-sm" : "text-slate-500"} disabled:opacity-40`}>
              {t === "json" ? "JSON" : "Table"}
            </button>
          ))}
        </div>
      </div>

      {!tableOk && (
        <p className="mb-2 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[10px] text-amber-700">{parsed.reason} The table view is unavailable until this is fixed.</p>
      )}

      {activeTab === "json" ? (
        <textarea value={value || ""} onChange={(e) => onChange(e.target.value)} rows={10} spellCheck={false}
          placeholder={'{"rules":[{"when":{"op":"contains","value":"Gov"},"then":"GOVERNMENT"}],"else":"OTHER"}'}
          className={`${inputCls} w-full font-mono text-[11px]`} />
      ) : (
        <div className="space-y-2">
          <datalist id={datalistId}>{paths.map((p) => <option key={p} value={p} />)}</datalist>
          {model.rules.length === 0 && (
            <p className="rounded-xl bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">No rules yet. The first rule that matches wins; add an "Otherwise" below for everything else.</p>
          )}
          {model.rules.map((rule, i) => {
            const open = openIdx === i;
            const isResultRule = result && result.matched === i;
            return (
              <div key={i} className={`rounded-2xl border ${isResultRule ? "border-primary bg-primary/5" : "border-outline-variant"} `}>
                <div className="flex items-center gap-1 px-2.5 py-1.5">
                  <button type="button" onClick={() => setOpenIdx(open ? -1 : i)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700" title={summarizeRule(rule)}>{summarizeRule(rule)}</span>
                  </button>
                  <button type="button" aria-label="Move rule up" disabled={i === 0} onClick={() => moveRule(i, -1)} className={smallBtn}><span className="material-symbols-outlined text-[16px]">arrow_upward</span></button>
                  <button type="button" aria-label="Move rule down" disabled={i === model.rules.length - 1} onClick={() => moveRule(i, 1)} className={smallBtn}><span className="material-symbols-outlined text-[16px]">arrow_downward</span></button>
                  <button type="button" aria-label="Duplicate rule" disabled={model.rules.length >= MAX_RULES}
                    onClick={() => { commit({ ...model, rules: [...model.rules.slice(0, i + 1), JSON.parse(JSON.stringify(rule)), ...model.rules.slice(i + 1)] }); setOpenIdx(i + 1); }} className={smallBtn}>
                    <span className="material-symbols-outlined text-[16px]">content_copy</span>
                  </button>
                  <button type="button" aria-label="Delete rule" onClick={() => commit({ ...model, rules: model.rules.filter((_, k) => k !== i) })} className={`${smallBtn} hover:text-red-500`}>
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>
                {open && (
                  <div className="space-y-1.5 border-t border-outline-variant px-2.5 py-2">
                    {rule.conds.map((c, j) => {
                      const needsValue = OPERATORS.find((o) => o.value === c.op)?.input !== "none";
                      return (
                        <div key={j} className="flex flex-wrap items-center gap-1.5">
                          <span className="w-9 shrink-0 text-[10px] font-semibold uppercase text-slate-500">
                            {j === 0 ? "IF" : (
                              <button type="button" title="Toggle AND / OR for this rule" onClick={() => updateRule(i, { combine: rule.combine === "all" ? "any" : "all" })}
                                className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">{rule.combine === "all" ? "AND" : "OR"}</button>
                            )}
                          </span>
                          <input list={datalistId} value={c.path} onChange={(e) => updateCond(i, j, { path: e.target.value })}
                            placeholder="field (blank = this mapping's source)" className={`${inputCls} w-44`} />
                          <select value={c.op} onChange={(e) => updateCond(i, j, { op: e.target.value })} className={inputCls}>
                            {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          {needsValue && (
                            <input value={c.value} onChange={(e) => updateCond(i, j, { value: e.target.value })} placeholder="value" className={`${inputCls} min-w-0 flex-1`} />
                          )}
                          <label className="flex shrink-0 items-center gap-1 text-[10px] text-slate-500" title="Case-insensitive comparison">
                            <input type="checkbox" checked={c.ignoreCase} onChange={(e) => updateCond(i, j, { ignoreCase: e.target.checked })} />Aa
                          </label>
                          <button type="button" aria-label="Remove condition" disabled={rule.conds.length === 1}
                            onClick={() => updateRule(i, { conds: rule.conds.filter((_, k) => k !== j) })} className={smallBtn}>
                            <span className="material-symbols-outlined text-[16px]">close</span>
                          </button>
                        </div>
                      );
                    })}
                    <button type="button" onClick={() => updateRule(i, { conds: [...rule.conds, { path: "", op: "equals", value: "", ignoreCase: true }] })}
                      className="ml-10 text-[10px] font-semibold text-primary hover:underline">+ Add condition</button>
                    <div className="pt-1"><OutcomeInput label="THEN" outcome={rule.then} onChange={(then) => updateRule(i, { then })} /></div>
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" disabled={model.rules.length >= MAX_RULES}
            onClick={() => { commit({ ...model, rules: [...model.rules, emptyRule()] }); setOpenIdx(model.rules.length); }}
            className="rounded-full border border-dashed border-primary/50 px-3 py-1 text-[11px] font-semibold text-primary hover:bg-primary/5 disabled:opacity-40">
            + Add rule
          </button>
          <div className={`rounded-2xl border px-2.5 py-2 ${result && result.matched === "else" ? "border-primary bg-primary/5" : "border-outline-variant"}`}>
            <OutcomeInput label="OTHERWISE" allowEmpty outcome={model.otherwise} onChange={(otherwise) => commit({ ...model, otherwise })} />
          </div>
        </div>
      )}

      {errors.length > 0 && value && value.trim() && (
        <ul className="mt-2 list-disc space-y-0.5 rounded-xl bg-red-50 px-5 py-1.5 text-[10px] text-red-600">
          {errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}
          {errors.length > 5 && <li>…and {errors.length - 5} more</li>}
        </ul>
      )}

      {result && (
        <div className="mt-2 rounded-xl bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-600">
          <span className="font-semibold text-slate-500">Test with sample source: </span>
          {result.error ? <span className="text-slate-400">{result.error}</span> : (
            <>
              <code className="font-mono text-slate-800">{result.value === null || result.value === undefined ? "null" : JSON.stringify(result.value)}</code>
              <span className="text-slate-400"> · {result.matched === null ? "no rule matched" : result.matched === "else" ? "otherwise" : `rule ${result.matched + 1}`}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
