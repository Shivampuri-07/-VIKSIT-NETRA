import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  side: "left" | "right";
  title: string;
  icon: React.ElementType;
  /** localStorage key so the open/collapsed state survives reloads. */
  storageKey: string;
  /** size when open (Tailwind classes: width, and the stacked height on small screens) */
  widthClass: string;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}

const read = (k: string, d: boolean) => {
  try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch { return d; }
};

/**
 * Collapsible side panel. Collapsing NEVER unmounts the content (it is only hidden), so nothing the panel
 * holds is lost; the collapsed state is a slim rail with the title and an expand button.
 */
export const SidePanel: React.FC<Props> = ({ side, title, icon: Icon, storageKey, widthClass, defaultOpen = true, badge, children }) => {
  const [open, setOpen] = useState<boolean>(() => read(storageKey, defaultOpen));
  useEffect(() => { try { localStorage.setItem(storageKey, open ? "1" : "0"); } catch { /* ignore */ } }, [open, storageKey]);
  const Chevron = side === "left" ? (open ? ChevronLeft : ChevronRight) : (open ? ChevronRight : ChevronLeft);
  return (
    <section
      aria-label={title}
      data-testid={`panel-${side}`}
      data-open={open}
      className={`relative shrink-0 h-full bg-[#0D1117] flex flex-col transition-[width] duration-200 ${side === "left" ? "md:border-r border-b md:border-b-0" : "md:border-l border-t md:border-t-0"} border-[#30363D] ${open ? widthClass : "w-full h-11 md:h-full md:w-11"}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        className={`absolute top-2 z-20 w-6 h-6 rounded-[4px] bg-[#21262D] border border-[#30363D] text-[#8B949E] hover:text-[#C9D1D9] hover:border-[#58A6FF] flex items-center justify-center cursor-pointer right-2 ${side === "left" ? "md:-right-3 md:left-auto" : "md:-left-3 md:right-auto"}`}
      >
        <Chevron className="w-3.5 h-3.5" />
      </button>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-1 flex flex-row md:flex-col items-center gap-3 px-3 md:px-0 md:pt-10 text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer"
          title={`Expand ${title}`}
        >
          <Icon className="w-4 h-4 text-[#58A6FF]" />
          <span className="text-[10px] font-mono uppercase tracking-widest md:[writing-mode:vertical-rl] md:rotate-180">{title}</span>
          {badge}
        </button>
      )}
      <div className={`${open ? "flex" : "hidden"} flex-1 min-h-0 flex-col overflow-hidden`}>{children}</div>
    </section>
  );
};
