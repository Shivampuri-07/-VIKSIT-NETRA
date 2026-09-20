/**
 * Agentic investigation + advanced-analysis tests (Phases 2-3).
 * Scenarios: orchestrator selection/fallback, LangGraph adapter contract,
 * empty AIS, missing wind/current, invalid coordinates, counterfactuals,
 * exact Shapley additivity, review priority, feedback, capability honesty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { SceneService, REAL_SCENE_ID, assertSafeSceneId } from "../lib/scenes";
import {
  NODES, createInvestigation, defaultParams, executeInvestigation, investigationView, setModuleLoaderForTests,
  DETERMINISTIC_RUNTIME, LANGGRAPH_RUNTIME,
} from "../lib/investigation";
import { excludeVessel, forcingSensitivity, CF_LABEL } from "../lib/counterfactual";
import { runDrift } from "../lib/drift";
import { parseMarineCadastreCsv } from "../lib/ais";
import { validateFeedback } from "../lib/review";
import { loadCapabilities } from "../lib/capabilities";
import { searchEvidence } from "../lib/evidence_search";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const svc = new SceneService(ROOT);
const run = async (s: SceneService, sceneId = REAL_SCENE_ID, extra: any = {}) => {
  const inv = createInvestigation(defaultParams(sceneId, { num_particles: 120, ...extra }));
  await executeInvestigation(inv, s);
  return inv;
};

class NoAisService extends SceneService {
  ais(id: string) { const a = super.ais(id); return { ...a, tracks: [], records: 0 }; }
}
class NoWindService extends SceneService {
  environment(_id: string) { return { wind: { kind: "none" as const, label: "No wind product (test)" }, current: { kind: "none" as const, label: "No current product (test)" } }; }
}
class BadCoordService extends SceneService {
  detect(id: string, pol = "VV") { const d = super.detect(id, pol); d.geometry.centroid = [NaN, NaN]; d.geometry.coordinates = []; return d; }
}

// Minimal stub of the DOCUMENTED @langchain/langgraph API (Annotation.Root, StateGraph,
// addNode/addEdge/addConditionalEdges, START/END, compile().invoke()). It verifies the
// ADAPTER logic only; it is not LangGraph.
function langGraphContractStub() {
  const START = "__start__", END = "__end__";
  const Annotation: any = () => ({});
  Annotation.Root = (spec: any) => ({ spec });
  class StateGraph {
    nodes = new Map<string, (s: any) => Promise<any>>(); edges = new Map<string, string>(); cond = new Map<string, (s: any) => string>();
    constructor(public schema: any) {}
    addNode(id: string, fn: any) { this.nodes.set(id, fn); return this; }
    addEdge(a: string, b: string) { this.edges.set(a, b); return this; }
    addConditionalEdges(a: string, fn: any, _map?: string[]) { this.cond.set(a, fn); return this; }
    compile() {
      return { invoke: async (input: any, cfg: any) => {
        let state = { ...input }; let cur = this.edges.get(START)!; let steps = 0;
        while (cur !== END) {
          if (++steps > (cfg?.recursionLimit ?? 25)) throw new Error("recursion limit");
          state = { ...state, ...(await this.nodes.get(cur)!(state)) };
          cur = this.cond.has(cur) ? this.cond.get(cur)!(state) : this.edges.get(cur) ?? END;
        }
        return state;
      } };
    }
  }
  return { StateGraph, Annotation, START, END };
}

test("12 agents in the required order", () => {
  assert.deepEqual(NODES.map((n) => n.label), [
    "Scene & SAR Detection Agent", "Spill Geometry Agent", "Environmental Forcing Agent", "Backtracking Agent",
    "Forward Drift Forecast Agent", "AIS Candidate Retrieval Agent", "Vessel Attribution & Evidence Agent",
    "Uncertainty & Quality-Control Agent", "Competing-Hypotheses Agent", "Risk Assessment Agent",
    "Response Recommendation Agent", "Final Evidence & Report Agent",
  ]);
});

test("AEGIS_ORCHESTRATOR=deterministic -> labelled DETERMINISTIC_FALLBACK (no LangGraph, no LLM)", async () => {
  process.env.AEGIS_ORCHESTRATOR = "deterministic";
  try {
    const inv = await run(svc);
    const v = investigationView(inv);
    assert.equal(v.graph.orchestrator, "deterministic");
    assert.equal(v.graph.orchestrator_status, "DETERMINISTIC_FALLBACK");
    assert.equal(v.graph.orchestrator_info!.graph_node_invocations, 0);
    assert.equal(v.graph.orchestrator_info!.llm_used, false);
    assert.equal(v.graph.runtime, DETERMINISTIC_RUNTIME);
    assert.ok(inv.events.filter((e) => e.status === "completed").length === 12);
    for (const e of inv.events.filter((x) => x.status === "completed" && x.node !== "report_generation")) assert.ok(e.data_sources?.length, `${e.node} carries provenance`);
  } finally { delete process.env.AEGIS_ORCHESTRATOR; }
});

test("default (auto) runs the REAL @langchain/langgraph StateGraph and matches the fallback's results", async () => {
  delete process.env.AEGIS_ORCHESTRATOR;
  const lg = await run(svc);
  const v = investigationView(lg);
  assert.equal(v.graph.orchestrator_status, "LANGGRAPH", "real LangGraph loaded and executed");
  assert.equal(v.graph.orchestrator_info!.package, "@langchain/langgraph");
  assert.match(String(v.graph.orchestrator_info!.package_version), /^\d+\.\d+\.\d+/);
  assert.equal(v.graph.orchestrator_info!.graph_node_invocations, 12, "every node was invoked BY the LangGraph runtime");
  assert.equal(v.graph.orchestrator_info!.llm_used, false);
  process.env.AEGIS_ORCHESTRATOR = "deterministic";
  try {
    const det = await run(svc);
    assert.deepEqual(lg.events.map((e) => `${e.node}:${e.status}`), det.events.map((e) => `${e.node}:${e.status}`));
    assert.equal(lg.state.attribution!.candidates[0].mmsi, det.state.attribution!.candidates[0].mmsi);
    assert.equal(lg.state.attribution!.candidates[0].composite_score, det.state.attribution!.candidates[0].composite_score);
  } finally { delete process.env.AEGIS_ORCHESTRATOR; }
});

test("LangGraph module cannot be loaded -> honest DETERMINISTIC_FALLBACK, no fake LangGraph", async () => {
  process.env.AEGIS_ORCHESTRATOR = "langgraph";
  setModuleLoaderForTests(async () => { throw new Error("Cannot find package '@langchain/langgraph'"); });
  try {
    const inv = await run(svc);
    assert.equal(inv.orchestrator, "deterministic");
    assert.equal(inv.orchestrator_info!.status, "DETERMINISTIC_FALLBACK");
    assert.match(inv.runtime, /LangGraph not available/);
    assert.ok(inv.state.warnings.some((w) => w.startsWith("[Orchestrator]") && /could not be loaded/.test(w)));
    assert.equal(inv.status, "completed");
  } finally { setModuleLoaderForTests(null); delete process.env.AEGIS_ORCHESTRATOR; }
});

test("LangGraph adapter (contract stub): same nodes, same routing, same results", async () => {
  process.env.AEGIS_ORCHESTRATOR = "langgraph";
  setModuleLoaderForTests(async () => langGraphContractStub());
  try {
    const lg = await run(svc);
    process.env.AEGIS_ORCHESTRATOR = "deterministic";
    const det = await run(svc);
    assert.equal(lg.orchestrator, "langgraph");
    assert.equal(lg.runtime, LANGGRAPH_RUNTIME);
    assert.deepEqual(lg.events.map((e) => `${e.node}:${e.status}`), det.events.map((e) => `${e.node}:${e.status}`));
    assert.equal(lg.state.attribution!.candidates[0].mmsi, det.state.attribution!.candidates[0].mmsi);
    process.env.AEGIS_ORCHESTRATOR = "langgraph";
    const empty = await run(new NoAisService(ROOT));
    assert.equal(empty.node_status["evidence_fusion"], "skipped");  // conditional edge taken inside the graph
    assert.equal(empty.node_status["uncertainty"], "completed");
  } finally { setModuleLoaderForTests(null); delete process.env.AEGIS_ORCHESTRATOR; }
});

test("empty AIS: attribution skipped by routing, hypotheses + report still produced", async () => {
  const inv = await run(new NoAisService(ROOT));
  assert.equal(inv.status, "completed");
  assert.equal(inv.node_status["evidence_fusion"], "skipped");
  assert.equal(inv.state.attribution, undefined);
  assert.ok(inv.state.hypotheses!.find((h) => h.id === "H1")!.contradicting.some((e) => /No candidate vessels/.test(e.text)));
  assert.equal(inv.node_status["report_generation"], "completed");
});

test("missing wind AND current: labelled NOT_AVAILABLE, drift still runs on the prior only", async () => {
  const inv = await run(new NoWindService(ROOT));
  const a = inv.state.environment!.at_observation;
  assert.equal(a.wind_status, "NOT_AVAILABLE");
  assert.equal(a.current_status, "NOT_AVAILABLE");
  assert.equal(inv.state.backward!.forcing.wind_status_fractions["NOT_AVAILABLE"], 1);
  assert.ok(inv.state.backward!.warnings.some((w) => /wind/i.test(w)));
  assert.equal(inv.status, "completed");
});

test("invalid coordinates: drift rejects them; the graph records the failure and still reports", async () => {
  assert.throws(() => runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [NaN, 5], env: { wind: { kind: "none", label: "x" }, current: { kind: "none", label: "x" } } }, { mode: "FORWARD", hours: 1 }), /Invalid seed coordinates/);
  assert.throws(() => runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [95, 5], env: { wind: { kind: "none", label: "x" }, current: { kind: "none", label: "x" } } }, { mode: "FORWARD", hours: 1 }), /Invalid seed coordinates/);
  const inv = await run(new BadCoordService(ROOT));
  assert.equal(inv.node_status["backward_origin"], "failed");
  assert.equal(inv.node_status["forward_forecast"], "failed");
  assert.equal(inv.node_status["report_generation"], "completed");
  const pts = parseMarineCadastreCsv("mmsi,base_date_time,longitude,latitude\n1,2020-01-01 00:00:00,-89,95\n2,2020-01-01 00:00:00,abc,28\n3,2020-01-01 00:00:00,-89,28\n");
  assert.deepEqual(pts.map((p) => p.mmsi), ["3"]);
  assert.throws(() => assertSafeSceneId("../../etc/passwd"));
});

test("counterfactual: excluding the top vessel re-ranks and updates hypotheses (analytical scenario)", async () => {
  const inv = await run(svc);
  const top = inv.state.attribution!.candidates[0];
  const cf = excludeVessel(inv, svc, top.mmsi);
  assert.equal(cf.label, CF_LABEL);
  assert.ok(cf.top_candidate_changed);
  assert.ok(!cf.top_after.some((c) => c.mmsi === top.mmsi));
  assert.equal(cf.top_after[0].mmsi, inv.state.attribution!.candidates[1].mmsi); // scores are independent: #2 becomes #1
  assert.equal(cf.hypotheses.length, 4);
  assert.throws(() => excludeVessel(inv, svc, "000000000"), /not among the scored vessels/);
});

test("counterfactual: forcing sensitivity with a REAL current product varies the product (what-if cases)", async () => {
  const inv = await run(svc);
  const r = forcingSensitivity(inv, svc);
  assert.equal(r.current_product_available, true, "the 2018 HYCOM current field is connected");
  assert.deepEqual(r.scenarios.map((x) => x.scenario), ["as_run", "no_current", "current_x0_5", "current_x1_5", "wind_factor_2pct", "wind_factor_4pct"]);
  assert.equal(r.scenarios[0].origin_shift_km, 0);
  const noCur = r.scenarios.find((x) => x.scenario === "no_current")!;
  assert.ok(noCur.origin_shift_km > 0.5, `removing the real current moves the origin estimate (${noCur.origin_shift_km} km)`);
  assert.match(r.note, /what-if sensitivity scenarios, not data/);
  assert.equal(typeof r.conclusion_stable, "boolean");
});

test("counterfactual: forcing sensitivity WITHOUT a current product varies only the zero-mean prior", async () => {
  class NoCurrentService extends SceneService {
    environment(id: string) { const e = super.environment(id); return { ...e, current: { kind: "none" as const, label: "No current (test)" } }; }
  }
  const nc = new NoCurrentService(ROOT);
  const inv = await run(nc);
  const r = forcingSensitivity(inv, nc);
  assert.equal(r.current_product_available, false);
  assert.equal(r.scenarios.length, 5);
  assert.equal(r.scenarios[0].origin_shift_km, 0);
  const asRun = r.scenarios.find((x) => x.scenario === "as_run")!;
  const windOnly = r.scenarios.find((x) => x.scenario === "wind_only")!;
  assert.ok(windOnly.origin_r90_km < asRun.origin_r90_km, "removing the current prior narrows the origin envelope");
});

test("exact Shapley decomposition: additive and centred", async () => {
  const inv = await run(svc);
  const c = inv.state.attribution!.candidates;
  for (const v of c) assert.ok(v.explanation.additivity_error < 1e-9, `${v.mmsi} additivity ${v.explanation.additivity_error}`);
  for (const k of ["spatial", "temporal", "trajectory", "consistency"] as const) {
    const m = c.reduce((a, v) => a + v.explanation.contributions[k], 0) / c.length;
    assert.ok(Math.abs(m) < 1e-3, `${k} contributions centred (mean ${m})`);
  }
});

test("review priority + feedback records", async () => {
  const inv = await run(svc);
  const r = (inv.state.report as any).review;
  assert.equal(r.level, "HIGH");
  assert.ok(r.reasons.includes("low-wind SAR look-alike risk"));
  const exists = (id: string) => id === inv.id;
  assert.equal(validateFeedback({ investigation_id: inv.id, target: "vessel", verdict: "rejected", mmsi: "367642980" }, exists).ok, true);
  assert.equal(validateFeedback({ investigation_id: inv.id, target: "vessel", verdict: "maybe", mmsi: "1" }, exists).ok, false);
  assert.equal(validateFeedback({ investigation_id: "nope", target: "detection", verdict: "confirmed" }, exists).ok, false);
});

test("evidence search: deterministic, and every value comes from the investigation state", async () => {
  const inv = await run(svc);
  const st = inv.state as any;
  const top = st.attribution!.candidates[0];

  // 1. ranking query returns the engine's own order and scores
  const a = searchEvidence(st, "Which vessels have the strongest evidence?");
  assert.equal(a.intent, "top_candidates");
  assert.equal(a.hits[0].mmsi, top.mmsi);
  assert.equal(a.hits[0].score, top.composite_score);
  assert.deepEqual(a.hits[0].supporting, top.why_priority);
  assert.deepEqual(a.hits[0].contradicting, top.contradicting_evidence);

  // 2. a named vessel resolves to that vessel only
  const byName = searchEvidence(st, `Show evidence for ${top.vessel_name}`);
  assert.equal(byName.intent, "vessel_detail");
  assert.equal(byName.hits[0].mmsi, top.mmsi);
  assert.equal(searchEvidence(st, `Why is ${top.mmsi} a candidate?`).hits[0].mmsi, top.mmsi);

  // 3. an unknown vessel is reported as unmatched, never invented
  const miss = searchEvidence(st, "Show evidence for NOT_A_REAL_SHIP_XYZ");
  assert.ok(miss.notes.some((n) => /none matched/i.test(n)));
  assert.ok(miss.hits.every((h) => st.attribution!.candidates.some((c: any) => c.mmsi === h.mmsi)));

  // 4. every returned MMSI exists in the state, for every supported intent
  for (const q of ["closest to the origin", "show the AIS evidence", "what evidence is missing?", "how big is the spill?"]) {
    for (const h of searchEvidence(st, q).hits) {
      if (h.mmsi) assert.ok(st.attribution!.candidates.some((c: any) => c.mmsi === h.mmsi), `${q} invented ${h.mmsi}`);
    }
  }

  // 5. missing-evidence answers are drawn from the hypotheses/uncertainty/warnings already recorded
  const gaps = searchEvidence(st, "what evidence is missing?");
  assert.equal(gaps.intent, "missing_evidence");
  const known = [
    ...st.hypotheses!.flatMap((h: any) => h.missing_evidence ?? []),
    ...st.uncertainty!.components.map((c: any) => c.basis),
    ...st.warnings,
  ];
  for (const f of gaps.hits[0].facts) assert.ok(known.includes(f.value), `unknown gap text: ${f.value}`);

  // 6. deterministic: same query, same answer
  assert.deepEqual(searchEvidence(st, "top vessels"), searchEvidence(st, "top vessels"));
});

test("evidence search without attribution says additional data is required", () => {
  const answer = searchEvidence({ ais: null, hypotheses: [], warnings: [] }, "which vessels have the strongest evidence?");
  assert.equal(answer.hits.length, 0);
  assert.match(answer.notes.join(" "), /additional investigation data is required/i);
});

test("capability registry is honest", () => {
  const cap = loadCapabilities(ROOT);
  const allowed = Object.keys(cap.statuses);
  for (const c of cap.capabilities) {
    assert.ok(allowed.includes(c.status), c.id);
    if (c.status === "IMPLEMENTED" || c.status === "IMPLEMENTED_HEURISTIC") assert.ok(c.evidence, `${c.id} claims implementation without evidence`);
    if (c.status === "EXTENSION_POINT" || c.status === "BLOCKED_BY_DATA") assert.ok(c.blocker, `${c.id} must state its blocker`);
  }
  assert.equal(cap.capabilities.find((c: any) => c.id === "langgraph").status, "IMPLEMENTED", "LangGraph is verified by a real run (see the default-orchestrator test)");
  assert.ok(cap.capabilities.find((c: any) => c.id === "hycom_current"), "current product capability is registered");
});
