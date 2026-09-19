# Labelled-data protocol (training / evaluation)

**Status of the repository:** no labelled training data is present (`ml/datasets/radar_data/Radar_data/` is empty; the
Zenodo 10.5281/zenodo.4672426 dataset must be downloaded separately). No 2023-2026 labelled data exists in the repository.

Rules
1. Only scenes with a documented, human (or authority-confirmed) oil mask are ground truth. Unlabelled imagery,
   model predictions, pseudo-labels and self-training outputs are **rejected** (`validate_labelled_manifest.py`).
2. Every scene needs: `scene_id, sensor, polarization, acquisition_utc, lon_min, lat_min, lon_max, lat_max,
   image_path, mask_path, label_source, label_method, annotator, license, split`.
3. Splits are by **scene/event**, never by patch: a scene appears in exactly one split; test scenes closer than
   50 km and 3 days to a training scene are flagged as leakage.
4. Report the distribution (years, sensors, regions, label sources) before training.
5. The frozen baseline (`ml/baseline/BASELINE_v1.json`) is re-evaluated with the SAME protocol
   (`ml/evaluation/protocol.py`) on the same test scenes before any comparison.

Check a manifest: `python ml/data/validate_labelled_manifest.py manifest.csv --check-files <data root>`
