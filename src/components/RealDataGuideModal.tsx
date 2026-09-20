import React from "react";
import { X, BookOpen, Key, Download, Globe, Database, ExternalLink, Terminal } from "lucide-react";

interface RealDataGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RealDataGuideModal: React.FC<RealDataGuideModalProps> = ({
  isOpen,
  onClose
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[1px] flex items-center justify-center p-4 select-none">
      <div className="bg-surface border border-line rounded-[6px] max-w-3xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto text-xs font-mono">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-navy-600" />
            <h3 className="font-bold text-ink text-sm">Real Satellite & Ocean Data Ingestion Guide</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-muted leading-relaxed font-sans">
          The prototype runs locally with calibrated synthetic scenes for instant laptop testing. 
          To transition to live production research, connect the four official open-access APIs below.
        </p>

        {/* 4 Data Providers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Copernicus SAR */}
          <div className="bg-canvas border border-line rounded-[4px] p-3 space-y-1.5">
            <div className="flex items-center justify-between text-navy-600 font-bold">
              <span>1. Sentinel-1 SAR (Copernicus)</span>
              <Globe className="w-4 h-4" />
            </div>
            <p className="text-muted text-[11px] font-sans">
              <b>Source:</b> Copernicus Data Space Ecosystem (CDSE)
            </p>
            <p className="text-muted text-[11px] font-sans">
              <b>Data Type:</b> Sentinel-1 C-SAR Level-1 GRD (IW mode, VV polarization).
            </p>
            <div className="text-[10px] text-ink bg-surface p-2 rounded-[3px] border border-line font-mono">
              URL: https://dataspace.copernicus.eu<br/>
              Env: COPERNICUS_CLIENT_ID, COPERNICUS_CLIENT_SECRET (or USERNAME/PASSWORD)
            </div>
          </div>

          {/* Copernicus Marine */}
          <div className="bg-canvas border border-line rounded-[4px] p-3 space-y-1.5">
            <div className="flex items-center justify-between text-navy-600 font-bold">
              <span>2. Ocean Currents (CMEMS)</span>
              <Database className="w-4 h-4" />
            </div>
            <p className="text-muted text-[11px] font-sans">
              <b>Source:</b> Copernicus Marine Service (Global Analysis & Forecast)
            </p>
            <p className="text-muted text-[11px] font-sans">
              <b>Variables:</b> Surface eastward velocity (uo), northward velocity (vo).
            </p>
            <div className="text-[10px] text-ink bg-surface p-2 rounded-[3px] border border-line font-mono">
              API: Copernicus Marine Python Client / REST API<br/>
              Env: COPERNICUS_MARINE_USERNAME, COPERNICUS_MARINE_PASSWORD
            </div>
          </div>

          {/* ERA5 Wind */}
          <div className="bg-canvas border border-line rounded-[4px] p-3 space-y-1.5">
            <div className="flex items-center justify-between text-ok font-bold">
              <span>3. Atmospheric Winds (ERA5)</span>
              <Download className="w-4 h-4" />
            </div>
            <p className="text-muted text-[11px] font-sans">
              <b>Source:</b> ECMWF Climate Data Store (CDS)
            </p>
            <p className="text-muted text-[11px] font-sans">
              <b>Variables:</b> 10m u-component (u10), 10m v-component (v10).
            </p>
            <div className="text-[10px] text-ink bg-surface p-2 rounded-[3px] border border-line font-mono">
              API: CDS API / ERA5 Reanalysis<br/>
              Env: CDS_API_KEY, CDS_API_URL
            </div>
          </div>

          {/* AIS Maritime */}
          <div className="bg-canvas border border-line rounded-[4px] p-3 space-y-1.5">
            <div className="flex items-center justify-between text-teal font-bold">
              <span>4. AIS Vessel Tracks</span>
              <Key className="w-4 h-4" />
            </div>
            <p className="text-muted text-[11px] font-sans">
              <b>Source:</b> MarineCadastre.gov (US) or AISHub / Spire Global
            </p>
            <p className="text-muted text-[11px] font-sans">
              <b>Fields:</b> MMSI, Timestamp, Latitude, Longitude, SOG, COG, VesselType.
            </p>
            <div className="text-[10px] text-ink bg-surface p-2 rounded-[3px] border border-line font-mono">
              Format: GeoJSON / CSV / Parquet<br/>
              Env: AIS_DATA_DIR (e.g. ./data/raw/ais)
            </div>
          </div>
        </div>

        {/* Python Quickstart */}
        <div className="bg-canvas border border-line rounded-[4px] p-3 space-y-1.5">
          <div className="font-semibold text-ink flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-navy-600" />
            Terminal Pipeline Command:
          </div>
          <pre className="text-[11px] text-ok font-mono bg-surface p-2 rounded-[3px] border border-line overflow-x-auto">
            python3 -m unittest tests/test_pipeline.py
          </pre>
        </div>

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t border-line">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-[4px] bg-canvas hover:bg-subtle text-ink border border-line text-xs cursor-pointer font-mono"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
};

