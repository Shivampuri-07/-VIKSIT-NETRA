"""
Main FastAPI Application Entrypoint.
Sentinel-1 SAR Oil Spill Detection & Vessel Attribution System.
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.app.api.endpoints import router as api_router

app = FastAPI(
    title="Sentinel-1 Oil Spill Detection & Probable Vessel Attribution API",
    description="Decision-support system for SAR oil spill segmentation, Lagrangian particle backtracking, and AIS trajectory attribution.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS middleware for Next.js / Vite web frontend integration
# Explicit origins from the environment; credentials are never combined with a wildcard.
_cors_origins = [o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Mount API routes
app.include_router(api_router, prefix="/api")


@app.get("/")
def root():
    return {
        "message": "Sentinel-1 Oil Spill Detection & Vessel Attribution System API is running.",
        "documentation": "/docs",
        "health": "/api/health"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app.main:app", host="0.0.0.0", port=8000, reload=True)
