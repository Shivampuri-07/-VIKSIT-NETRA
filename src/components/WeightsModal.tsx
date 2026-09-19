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
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none">
      <div className="bg-[#161B22] border border-[#30363D] rounded-[6px] max-w-md w-full p-5 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#30363D] pb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#58A6FF]" />
            <h3 className="font-bold text-[#C9D1D9] text-sm">Attribution Scoring Weights</h3>
          </div>
          <button onClick={onClose} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-[#8B949E] leading-relaxed">
          Adjust the multi-factor objective weights for spatial proximity, temporal leeway, trajectory intersection, and vessel kinematics.
        </p>

        {/* Presets */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#8B949E] font-mono">Presets:</span>
          <button
            onClick={() => applyPreset("BALANCED")}
            className="px-2 py-1 bg-[#0D1117] hover:bg-[#21262D] border border-[#30363D] text-[#C9D1D9] rounded-[4px] text-xs font-mono cursor-pointer"
          >
            Balanced
          </button>
          <button
            onClick={() => applyPreset("SPATIAL_HEAVY")}
            className="px-2 py-1 bg-[#0D1117] hover:bg-[#21262D] border border-[#30363D] text-[#C9D1D9] rounded-[4px] text-xs font-mono cursor-pointer"
          >
            Spatial
          </button>
          <button
            onClick={() => applyPreset("TEMPORAL_HEAVY")}
            className="px-2 py-1 bg-[#0D1117] hover:bg-[#21262D] border border-[#30363D] text-[#C9D1D9] rounded-[4px] text-xs font-mono cursor-pointer"
          >
            Temporal
          </button>
        </div>

        {/* Sliders */}
        <div className="space-y-3 text-xs">
          <div>
            <div className="flex justify-between text-[#C9D1D9] mb-1 font-mono text-[11px]">
              <span>Spatial Proximity:</span>
              <span className="text-[#58A6FF]">{(Number(normSpatial) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={spatial}
              onChange={(e) => setSpatial(parseFloat(e.target.value))}
              className="w-full accent-[#58A6FF] cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-[#C9D1D9] mb-1 font-mono text-[11px]">
              <span>Temporal Alignment:</span>
              <span className="text-[#79C0FF]">{(Number(normTemporal) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={temporal}
              onChange={(e) => setTemporal(parseFloat(e.target.value))}
              className="w-full accent-[#79C0FF] cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-[#C9D1D9] mb-1 font-mono text-[11px]">
              <span>Trajectory Geometry:</span>
              <span className="text-[#bc8cff]">{(Number(normTrajectory) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={trajectory}
              onChange={(e) => setTrajectory(parseFloat(e.target.value))}
              className="w-full accent-[#bc8cff] cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-[#C9D1D9] mb-1 font-mono text-[11px]">
              <span>Kinematic Consistency:</span>
              <span className="text-[#AFF5B4]">{(Number(normConsistency) * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.80"
              step="0.05"
              value={consistency}
              onChange={(e) => setConsistency(parseFloat(e.target.value))}
              className="w-full accent-[#AFF5B4] cursor-pointer"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-3 border-t border-[#30363D]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-[4px] bg-[#0D1117] hover:bg-[#21262D] text-[#C9D1D9] border border-[#30363D] text-xs font-mono cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-[4px] bg-[#58A6FF] hover:bg-[#79C0FF] text-[#0D1117] text-xs font-bold font-mono flex items-center gap-1.5 cursor-pointer border border-[#58A6FF]"
          >
            <Check className="w-3.5 h-3.5" /> Apply Weights
          </button>
        </div>
      </div>
    </div>
  );
};

