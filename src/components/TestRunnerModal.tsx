import React, { useState } from "react";
import { X, Terminal, Play, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";

interface TestRunnerModalProps { isOpen: boolean; onClose: () => void; }
interface Result { name: string; passed: boolean; detail: string }

export const TestRunnerModal: React.FC<TestRunnerModalProps> = ({ isOpen, onClose }) => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [note, setNote] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  if (!isOpen) return null;
  const run = async () => {
    setIsRunning(true); setError(null); setResults(null);
    try {
      const r = await fetch("/api/selftest");
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const d = await r.json();
      setResults(d.results); setNote(d.note ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsRunning(false);
    }
  };
  const passed = results?.filter((x) => x.passed).length ?? 0;
  return (
    <div className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[1px] flex items-center justify-center p-4 select-none font-mono">
      <div className="bg-surface border border-line rounded-[6px] max-w-2xl w-full p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-line pb-3 shrink-0">
          <div className="flex items-center gap-2"><Terminal className="w-4 h-4 text-ok" /><h3 className="font-bold text-ink text-sm">Engine Self-Test</h3></div>
          <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center justify-between shrink-0">
          <p className="text-xs text-muted font-sans">Runs in-process checks on the live server engines: compass conventions, forward/backward drift, hemisphere deflection, ERA5 values, and reproduction of the 2018 offline attribution.</p>
          <button onClick={run} disabled={isRunning} className="px-3.5 py-1.5 rounded-[4px] bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 shrink-0 ml-3 cursor-pointer border border-[#2ea043]">
            {isRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}<span>Run</span>
          </button>
        </div>
        <div className="flex-1 bg-canvas border border-line rounded-[4px] p-3 text-xs overflow-y-auto min-h-[220px] space-y-1.5">
          {error && <div className="text-[#FF4444]">Self-test request failed: {error}</div>}
          {!results && !error && <div className="h-full flex items-center justify-center text-muted italic">Press Run to execute the self-test.</div>}
          {results && (
            <>
              <div className={passed === results.length ? "text-ok" : "text-[#FF4444]"}>{passed}/{results.length} checks passed</div>
              {results.map((r, i) => (
                <div key={i} className="flex gap-2">
                  {r.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-ok shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />}
                  <div><div className="text-ink">{r.name}</div><div className="text-[10px] text-muted">{r.detail}</div></div>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-line shrink-0">
          <div className="text-[10px] text-muted max-w-md">{note || "Full suite: npm run test:engine"}</div>
          <button onClick={onClose} className="px-4 py-1.5 rounded-[4px] bg-canvas hover:bg-subtle text-ink border border-line text-xs cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
};
