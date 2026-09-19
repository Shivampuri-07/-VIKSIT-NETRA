# Candidate checkpoints

Written ONLY by `ml/training/train.py`, one directory per run:
`<UTC timestamp>_<run name>/candidate_best.pth`, `run_config.json`, `metrics_history.json`.

Candidates are experiments (e.g. a 6-epoch run). They never replace the production
baseline `ml/checkpoints/unet_oil_spill_best.pth` automatically; see `ml/model_registry.json`
("candidates" and "policy") and `ml/baseline/BASELINE_v1.json`.
