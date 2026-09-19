"""
Compare a candidate checkpoint with the frozen baseline using the PRE-REGISTERED promotion rule
(ml/experiments/six_epoch_protocol.json -> "acceptance_rule"):

    Promote only if pooled AND macro Dice improve over the re-evaluated baseline, with no increase in
    false-alarm scenes and no worse calibration; otherwise the baseline stays. Never automatic.

Both reports must come from ml/evaluation/run_eval.py (identical protocol, same 7 held-out scenes). The decision is
computed on the registered evaluation protocol ("scene_overlap_protocol": whole-scene z-score, 256 px tiles, 32 px
overlap, threshold 0.5), which is also the preprocessing the candidate was trained with. The other protocols are
reported side by side for transparency and are NOT used to pick the outcome.

THIS SCRIPT NEVER COPIES, MOVES OR OVERWRITES A CHECKPOINT. It only writes a JSON decision record; promotion, if ever
done, is a separate, deliberate human action.

    python ml/evaluation/compare_candidate.py --baseline ml/results/eval_baseline.json \
        --candidate ml/results/eval_candidate_six_epoch.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DECISION_PROTOCOL = "scene_overlap_protocol"


def _num(x):
    return None if x is None else float(x)


def decide(base: dict, cand: dict) -> dict:
    b, c = base[DECISION_PROTOCOL], cand[DECISION_PROTOCOL]
    crit = []

    def add(name, rule, b_val, c_val, passed):
        crit.append({"criterion": name, "rule": rule, "baseline": _num(b_val), "candidate": _num(c_val), "passed": bool(passed)})

    add("pooled_dice", "candidate > baseline", b["pooled"]["dice"], c["pooled"]["dice"], c["pooled"]["dice"] > b["pooled"]["dice"])
    add("macro_dice", "candidate > baseline", b["macro_mean"]["dice"], c["macro_mean"]["dice"], c["macro_mean"]["dice"] > b["macro_mean"]["dice"])
    add("false_alarm_scenes", "candidate <= baseline", b["false_alarm_scenes"], c["false_alarm_scenes"], c["false_alarm_scenes"] <= b["false_alarm_scenes"])
    add("calibration_ece", "candidate <= baseline (no worse)", b["calibration"]["ece"], c["calibration"]["ece"], c["calibration"]["ece"] <= b["calibration"]["ece"])
    add("calibration_brier", "candidate <= baseline (no worse)", b["calibration"]["brier"], c["calibration"]["brier"], c["calibration"]["brier"] <= b["calibration"]["brier"])
    ok = all(x["passed"] for x in crit)

    per_scene = []
    bs = {s["scene"]: s for s in b["per_scene"]}
    for s in c["per_scene"]:
        o = bs[s["scene"]]
        per_scene.append({"scene": s["scene"], "baseline_dice": o["dice"], "candidate_dice": s["dice"], "delta": s["dice"] - o["dice"]})
    improved = sum(1 for x in per_scene if x["delta"] > 0)

    side = {}
    for key in ("historic_protocol", "scene_overlap_protocol", "patch_overlap_protocol"):
        bm = base[key]["macro_mean"]; cm = cand[key]["macro_mean"]
        bp = base[key]["pooled"]; cp = cand[key]["pooled"]
        side[key] = {"baseline_macro_dice": bm["dice"], "candidate_macro_dice": cm["dice"], "baseline_pooled_dice": bp["dice"], "candidate_pooled_dice": cp["dice"],
                     "baseline_macro_fpr": bm["pixel_false_positive_rate"], "candidate_macro_fpr": cm["pixel_false_positive_rate"]}

    return {
        "schema": "aegis.candidate_decision.v1",
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rule_source": "ml/experiments/six_epoch_protocol.json (acceptance_rule)",
        "decision_protocol": DECISION_PROTOCOL,
        "criteria": crit,
        "all_criteria_passed": ok,
        "decision": "PROMOTE_RECOMMENDED" if ok else "KEEP_BASELINE",
        "promoted": False,
        "promotion_note": "This script never promotes. If PROMOTE_RECOMMENDED, a human must review this record and act deliberately; the frozen checkpoint is never overwritten automatically.",
        "per_scene_dice": per_scene,
        "scenes_improved": f"{improved} of {len(per_scene)}",
        "protocols_side_by_side": side,
        "statistical_caveat": "7 held-out scenes with large between-scene spread (SD of per-scene Dice about 0.3): differences are descriptive; no significance is claimed.",
        "baseline_checkpoint_sha256": base["checkpoint"]["sha256"],
        "candidate_checkpoint_sha256": cand["checkpoint"]["sha256"],
        "baseline_unchanged_at_end_of_both_evaluations": bool(base.get("frozen_baseline_unchanged")) and bool(cand.get("frozen_baseline_unchanged")),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default=os.path.join(PROJECT_ROOT, "ml", "results", "eval_baseline.json"))
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--out", default=os.path.join(PROJECT_ROOT, "ml", "results", "comparison_candidate_vs_baseline.json"))
    a = ap.parse_args(argv)
    base, cand = json.load(open(a.baseline)), json.load(open(a.candidate))
    if base["dataset"]["scene_ids"] != cand["dataset"]["scene_ids"]:
        print("REFUSED: the two evaluations used different scenes", file=sys.stderr)
        return 2
    if base["threshold"] != cand["threshold"]:
        print("REFUSED: different thresholds", file=sys.stderr)
        return 2
    rec = decide(base, cand)
    json.dump(rec, open(a.out, "w"), indent=2)
    for x in rec["criteria"]:
        print(f"{'PASS' if x['passed'] else 'FAIL'}  {x['criterion']:20s} baseline {x['baseline']:.4f}  candidate {x['candidate']:.4f}  ({x['rule']})")
    print(f"DECISION: {rec['decision']} (promoted: {rec['promoted']})  -> {os.path.relpath(a.out, PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
