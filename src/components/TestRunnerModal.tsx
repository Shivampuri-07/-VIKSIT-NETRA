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
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none font-mono">
      <div className="bg-[#161B22] border border-[#30363D] rounded-[6px] max-w-2xl w-full p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-[#30363D] pb-3 shrink-0">
          <div className="flex items-center gap-2"><Terminal className="w-4 h-4 text-[#AFF5B4]" /><h3 className="font-bold text-[#C9D1D9] text-sm">Engine Self-Test</h3></div>
          <button onClick={onClose} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center justify-between shrink-0">
          <p className="text-xs text-[#8B949E] font-sans">Runs in-process checks on the live server engines: compass conventions, forward/backward drift, hemisphere deflection, ERA5 values, and reproduction of the 2018 offline attribution.</p>
          <button onClick={run} disabled={isRunning} className="px-3.5 py-1.5 rounded-[4px] bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 shrink-0 ml-3 cursor-pointer border border-[#2ea043]">
            {isRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}<span>Run</span>
          </button>
        </div>
        <div className="flex-1 bg-[#0D1117] border border-[#30363D] rounded-[4px] p-3 text-xs overflow-y-auto min-h-[220px] space-y-1.5">
          {error && <div className="text-[#FF4444]">Self-test request failed: {error}</div>}
          {!results && !error && <div className="h-full flex items-center justify-center text-[#8B949E] italic">Press Run to execute the self-test.</div>}
          {results && (
            <>
              <div className={passed === results.length ? "text-[#AFF5B4]" : "text-[#FF4444]"}>{passed}/{results.length} checks passed</div>
              {results.map((r, i) => (
                <div key={i} className="flex gap-2">
                  {r.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-[#3fb950] shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 text-[#f85149] shrink-0 mt-0.5" />}
                  <div><div className="text-[#C9D1D9]">{r.name}</div><div className="text-[10px] text-[#8B949E]">{r.detail}</div></div>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-[#30363D] shrink-0">
          <div className="text-[10px] text-[#8B949E] max-w-md">{note || "Full suite: npm run test:engine"}</div>
          <button onClick={onClose} className="px-4 py-1.5 rounded-[4px] bg-[#0D1117] hover:bg-[#21262D] text-[#C9D1D9] border border-[#30363D] text-xs cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
};
