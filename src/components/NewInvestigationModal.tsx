import React from "react";
import { Satellite, Plug, MapPin, ChevronRight, Play } from "lucide-react";
import { Modal, Tag } from "./ui";
import type { Scene } from "../types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scenes: Scene[];
  selectedSceneId: string;
  onOpenUpload: () => void;
  onOpenConnect: () => void;
  onOpenScene: (sceneId: string) => void;
  isAnalyzing: boolean;
}

/** Entry point for a new investigation. The bundled incidents stay one click away. */
export const NewInvestigationModal: React.FC<Props> = ({
  isOpen,
  onClose,
  scenes,
  selectedSceneId,
  onOpenUpload,
  onOpenConnect,
  onOpenScene,
  isAnalyzing,
}) => {
  const options = [
    {
      id: "upload",
      icon: Satellite,
      title: "Upload satellite / SAR image",
      hint: "Score a single-band Sentinel-1 style GeoTIFF with the frozen U-Net, then investigate the detection.",
      tag: <Tag tone="ok">Implemented</Tag>,
      onClick: () => { onClose(); onOpenUpload(); },
    },
    {
      id: "connect",
      icon: Plug,
      title: "Connect external data",
      hint: "AIS, satellite catalogue, environmental fields or a REST endpoint.",
      tag: <Tag tone="neutral">Future connector</Tag>,
      onClick: () => { onClose(); onOpenConnect(); },
    },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New investigation"
      icon={Play}
      subtitle="Start from an image you have, an external source, or an incident already in this workbench."
      maxWidth="max-w-2xl"
      footer={<button onClick={onClose} className="vn-btn">Close</button>}
    >
      <div className="space-y-4">
        <ul className="space-y-2">
          {options.map((o) => {
            const Icon = o.icon;
            return (
              <li key={o.id}>
                <button onClick={o.onClick} className="w-full text-left rounded-[10px] border border-line bg-surface hover:border-navy-600/40 hover:bg-subtle/60 p-3 flex items-start gap-3 cursor-pointer">
                  <span className="w-9 h-9 rounded-[9px] bg-navy-50 border border-navy-600/20 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-navy-600" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-ink">{o.title}</span>
                      {o.tag}
                    </span>
                    <span className="block text-[11.5px] text-muted mt-0.5 leading-snug">{o.hint}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-muted shrink-0 mt-2" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>

        <section className="border-t border-line pt-4">
          <h4 className="text-[13px] font-semibold text-ink flex items-center gap-1.5 mb-2">
            <MapPin className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" /> Open an existing incident
          </h4>
          <ul className="space-y-1.5">
            {scenes.map((s) => (
              <li key={s.scene_id}>
                <button
                  onClick={() => { onClose(); onOpenScene(s.scene_id); }}
                  disabled={isAnalyzing}
                  className={`w-full text-left rounded-[9px] border px-3 py-2 flex items-center justify-between gap-3 cursor-pointer disabled:opacity-50 ${
                    s.scene_id === selectedSceneId ? "border-navy-600/40 bg-navy-50" : "border-line bg-surface hover:bg-subtle"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-ink truncate">{s.name}</span>
                    <span className="block text-[11px] text-muted truncate">
                      {s.region} · {new Date(s.acquisition_time).toISOString().slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </span>
                  <span className="shrink-0 flex items-center gap-2">
                    {s.scene_id === selectedSceneId && <Tag tone="info">Open</Tag>}
                    {s.synthetic ? <Tag tone="accent">Synthetic demo</Tag> : s.scene_id.startsWith("UPLOAD_") ? <Tag tone="info">Uploaded</Tag> : <Tag tone="ok">Real data</Tag>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted mt-2">
            The bundled 2018 Gulf of Mexico incident is the reference case: real SAR, real AIS, real ERA5 wind and a real
            historical current field.
          </p>
        </section>
      </div>
    </Modal>
  );
};
