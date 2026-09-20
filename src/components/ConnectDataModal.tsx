import React, { useRef, useState } from "react";
import { Plug, Upload, CheckCircle2, AlertTriangle, Database } from "lucide-react";
import { Modal, Tag, KV } from "./ui";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The SAR upload path that IS implemented, offered here as the working alternative. */
  onOpenSarUpload: () => void;
}

type Check = { ok: boolean; message: string; details?: string[] } | null;

const CONNECTORS = [
  { id: "ais", label: "AIS dataset", hint: "MarineCadastre-style CSV of vessel position reports" },
  { id: "satellite", label: "Satellite catalogue", hint: "Copernicus Data Space / Sentinel Hub search and download" },
  { id: "environment", label: "Environmental fields", hint: "ERA5 wind, ocean-current products" },
  { id: "api", label: "Generic REST API", hint: "Any endpoint returning one of the formats above" },
];

/**
 * Scaffolding for future external-data connectors.
 * Nothing here ingests data yet: the only implemented path into this system is the SAR image upload.
 * Validation below is local format checking only - no request is made to the endpoint.
 */
export const ConnectDataModal: React.FC<Props> = ({ isOpen, onClose, onOpenSarUpload }) => {
  const [endpoint, setEndpoint] = useState("");
  const [kind, setKind] = useState("ais");
  const [check, setCheck] = useState<Check>(null);
  const [dataset, setDataset] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const validate = () => {
    const details: string[] = [];
    let url: URL | null = null;
    try {
      url = new URL(endpoint.trim());
    } catch {
      setCheck({ ok: false, message: "That is not a valid URL.", details: ["Expected something like https://example.org/api/ais"] });
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      setCheck({ ok: false, message: `Unsupported protocol "${url.protocol}".`, details: ["Only http and https can be used."] });
      return;
    }
    details.push(`Scheme: ${url.protocol.replace(":", "")}`);
    details.push(`Host: ${url.hostname}`);
    details.push(`Path: ${url.pathname || "/"}`);
    if (url.protocol === "http:") details.push("Warning: http is unencrypted; prefer https.");
    if (url.username || url.password || /(?:key|token|secret|password)=/i.test(url.search)) {
      details.push("Credentials detected in the URL — put them in server-side environment variables instead, never in a link.");
    }
    setCheck({
      ok: true,
      message: "Endpoint format is valid. No connection was attempted.",
      details,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Connect external data"
      icon={Plug}
      subtitle="Interface scaffolding for future data connectors."
      maxWidth="max-w-2xl"
      footer={<button onClick={onClose} className="vn-btn">Close</button>}
    >
      <div className="space-y-4">
        <div className="rounded-[10px] border border-warn/30 bg-warn-50 p-3 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-px" aria-hidden="true" />
          <p className="text-[12px] text-ink-soft leading-relaxed">
            <b className="text-warn">Future data connector.</b> None of the connectors below ingest data yet. The only
            data path implemented today is the SAR image upload, which runs the frozen U-Net.{" "}
            <button onClick={() => { onClose(); onOpenSarUpload(); }} className="text-navy-600 hover:underline cursor-pointer">
              Open SAR image upload
            </button>
            .
          </p>
        </div>

        <section>
          <h4 className="text-[13px] font-semibold text-ink mb-2">Planned connectors</h4>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {CONNECTORS.map((c) => (
              <li key={c.id} className="rounded-[9px] border border-line bg-surface p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-ink">{c.label}</span>
                  <Tag tone="neutral">Future</Tag>
                </div>
                <p className="text-[11px] text-muted mt-0.5 leading-snug">{c.hint}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-t border-line pt-4">
          <h4 className="text-[13px] font-semibold text-ink mb-2 flex items-center gap-1.5">
            <Plug className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" /> Connect an API
          </h4>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Connector type"
              className="border border-line-strong rounded-[8px] px-2.5 py-2 text-[12px] bg-surface text-ink"
            >
              {CONNECTORS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input
              value={endpoint}
              onChange={(e) => { setEndpoint(e.target.value); setCheck(null); }}
              placeholder="https://example.org/api/ais"
              className="flex-1 min-w-0 border border-line-strong rounded-[8px] px-3 py-2 text-[12.5px] bg-surface text-ink placeholder:text-faint"
            />
            <button onClick={validate} disabled={!endpoint.trim()} className="vn-btn shrink-0">Validate endpoint</button>
          </div>
          <p className="text-[11px] text-muted mt-1.5">
            Validation checks the URL format locally. No request is sent, nothing is stored, and no credentials belong here.
          </p>
          {check && (
            <div className={`mt-2 rounded-[9px] border p-2.5 ${check.ok ? "border-ok/30 bg-ok-50" : "border-danger/30 bg-danger-50"}`}>
              <div className={`flex items-center gap-1.5 text-[12.5px] font-medium ${check.ok ? "text-ok" : "text-danger"}`}>
                {check.ok ? <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> : <AlertTriangle className="w-4 h-4" aria-hidden="true" />}
                {check.message}
              </div>
              {check.details && (
                <ul className="mt-1 space-y-0.5">
                  {check.details.map((d, i) => <li key={i} className="text-[11px] text-ink-soft">• {d}</li>)}
                </ul>
              )}
              {check.ok && <p className="text-[11px] text-muted mt-1.5">Ingestion from this endpoint is not implemented — it will not appear as a scene.</p>}
            </div>
          )}
        </section>

        <section className="border-t border-line pt-4">
          <h4 className="text-[13px] font-semibold text-ink mb-2 flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" /> Upload a dataset
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => fileRef.current?.click()} className="vn-btn">
              <Upload className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" /> Choose dataset file
            </button>
            <input ref={fileRef} type="file" className="hidden" onChange={(e) => setDataset(e.target.files?.[0] ?? null)} />
            {dataset && <Tag tone="neutral">{dataset.name}</Tag>}
          </div>
          {dataset && (
            <div className="mt-2 space-y-0">
              <KV k="File" v={dataset.name} mono={false} />
              <KV k="Size" v={`${(dataset.size / 1e6).toFixed(2)} MB`} />
              <KV k="Type" v={dataset.type || "unknown"} />
              <KV k="Status" v="Inspected locally only — not uploaded, not ingested" />
            </div>
          )}
          <p className="text-[11px] text-muted mt-2 leading-relaxed">
            Dataset ingestion (AIS extracts, environmental fields) is a future connector. The file is read in your browser
            for its name and size only; it is not sent anywhere.
          </p>
        </section>
      </div>
    </Modal>
  );
};
