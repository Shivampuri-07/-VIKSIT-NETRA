import React, { useState } from "react";
import { X, Sliders, RotateCcw, Check } from "lucide-react";

interface WeightsModalProps {
  isOpen: boolean;
  onClose: () => void;
  weights: {
    spatial: number;
    temporal: number;
    trajectory: number;
    consistency: number;
  };
  onSave: (newWeights: {
    spatial: number;
    temporal: number;
    trajectory: number;
    consistency: number;
  }) => void;
}

export const WeightsModal: React.FC<WeightsModalProps> = ({
  isOpen,
  onClose,
  weights,
  onSave
}) => {
  const [spatial, setSpatial] = useState(weights.spatial);
  const [temporal, setTemporal] = useState(weights.temporal);
  const [trajectory, setTrajectory] = useState(weights.trajectory);
  const [consistency, setConsistency] = useState(weights.consistency);

  if (!isOpen) return null;

  const total = spatial + temporal + trajectory + consistency || 1;
  const normSpatial = (spatial / total).toFixed(2);
  const normTemporal = (temporal / total).toFixed(2);
  const normTrajectory = (trajectory / total).toFixed(2);
  const normConsistency = (consistency / total).toFixed(2);

  const applyPreset = (preset: "BALANCED" | "SPATIAL_HEAVY" | "TEMPORAL_HEAVY") => {
    if (preset === "BALANCED") {
      setSpatial(0.35);
      setTemporal(0.25);
      setTrajectory(0.25);
      setConsistency(0.15);
    } else if (preset === "SPATIAL_HEAVY") {
      setSpatial(0.55);
      setTemporal(0.15);
      setTrajectory(0.20);
      setConsistency(0.10);
    } else if (preset === "TEMPORAL_HEAVY") {
      setSpatial(0.25);
      setTemporal(0.45);
      setTrajectory(0.20);
      setConsistency(0.10);
    }
  };

  const handleSave = () => {
    onSave({
      spatial: Number(normSpatial),
      temporal: Number(normTemporal),
      trajectory: Number(normTrajectory),
      consistency: Number(normConsistency)
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[1px] flex items-center justify-center p-4 select-none">
      <div className="bg-surface border border-line rounded-[6px] max-w-md w-full p-5 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-navy-600" />
            <h3 className="font-bold text-ink text-sm">Attribution Scoring Weights</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-muted leading-relaxed">
          Adjust the multi-factor objective weights for spatial proximity, temporal leeway, trajectory intersection, and vessel kinematics.
        </p>

        {/* Presets */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted font-mono">Presets:</span>
          <button
            onClick={() => applyPreset("BALANCED")}
            className="px-2 py-1 bg-canvas hover:bg-subtle border border-line text-ink rounded-[4px] text-xs font-mono cursor-pointer"
          >
            Balanced
          </button>
          <button
            onClick={() => applyPreset("SPATIAL_HEAVY")}
            className="px-2 py-1 bg-canvas hover:bg-subtle border border-line text-ink rounded-[4px] text-xs font-mono cursor-pointer"
          >
            Spatial
          </button>
          <button
            onClick={() => applyPreset("TEMPORAL_HEAVY")}
            className="px-2 py-1 bg-canvas hover:bg-subtle border border-line text-ink rounded-[4px] text-xs font-mono cursor-pointer"
          >
            Temporal
          </button>
        </div>

        {/* Sliders */}
        <div className="space-y-3 text-xs">
          <div>
            <div className="flex justify-between text-ink mb-1 font-mono text-[11px]">
              <span>Spatial Proximity:</span>
              <span className="text-navy-600">{(Number(normSpatial) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={spatial}
              onChange={(e) => setSpatial(parseFloat(e.target.value))}
              className="w-full accent-[#1e4e82] cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-ink mb-1 font-mono text-[11px]">
              <span>Temporal Alignment:</span>
              <span className="text-navy-600">{(Number(normTemporal) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={temporal}
              onChange={(e) => setTemporal(parseFloat(e.target.value))}
              className="w-full accent-[#2c7a7b] cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-ink mb-1 font-mono text-[11px]">
              <span>Trajectory Geometry:</span>
              <span className="text-teal">{(Number(normTrajectory) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={trajectory}
              onChange={(e) => setTrajectory(parseFloat(e.target.value))}
              className="w-full accent-[#5b6ec4] cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-ink mb-1 font-mono text-[11px]">
              <span>Kinematic Consistency:</span>
              <span className="text-ok">{(Number(normConsistency) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={consistency}
              onChange={(e) => setConsistency(parseFloat(e.target.value))}
              className="w-full accent-[#b7791f] cursor-pointer"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-3 border-t border-line">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-[4px] bg-canvas hover:bg-subtle text-ink border border-line text-xs font-mono cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-[4px] bg-navy hover:bg-navy-600 text-white text-xs font-bold font-mono flex items-center gap-1.5 cursor-pointer border border-navy"
          >
            <Check className="w-3.5 h-3.5" /> Apply Weights
          </button>
        </div>
      </div>
    </div>
  );
};

