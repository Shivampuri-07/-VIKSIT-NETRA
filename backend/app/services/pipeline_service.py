from __future__ import annotations

import csv
import math
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import rasterio
from pyproj import Transformer

from ml.inference.segmenter import OilSpillSegmenter
from drift.models.lagrangian import LagrangianDriftModel
from ais.trajectory import AISTrajectoryEngine
from attribution.scorer import ExplainableAttributionScorer
from gis.processing.geometry import haversine_distance


class OilSpillPipelineService:
    """
    AEGIS real-data oil-spill detection and attribution pipeline.

    Pipeline:
        Sentinel-1 SAR
            ↓
        trained U-Net segmentation
            ↓
        spill geometry
            ↓
        ERA5 10 m wind
            ↓
        Lagrangian backward drift
            ↓
        MarineCadastre AIS
            ↓
        trajectory reconstruction
            ↓
        explainable vessel ranking

    Important:
        - AIS source is MarineCadastre only.
        - ERA5 is used for atmospheric wind forcing.
        - The configured ocean-current values are model defaults unless
          explicitly supplied through the API.
        - Vessel attribution is decision support, not proof of causality.
    """

    def __init__(self, data_mode: Optional[str] = None) -> None:

        # --------------------------------------------------------------
        # PROJECT ROOT
        # --------------------------------------------------------------

        # Docker:
        #   PROJECT_ROOT=/app
        #
        # Local development:
        #   automatically resolves to the repository root.
        #
        # This fixes the previous problem where /app was hard-coded
        # when running the service directly on macOS.
        default_root = Path(__file__).resolve().parents[3]

        self.project_root = Path(
            os.getenv(
                "PROJECT_ROOT",
                str(default_root),
            )
        ).resolve()

        # --------------------------------------------------------------
        # MODEL
        # --------------------------------------------------------------

        self.model_path = Path(
            os.getenv(
                "MODEL_PATH",
                str(
                    self.project_root
                    / "ml"
                    / "checkpoints"
                    / "unet_oil_spill_best.pth"
                ),
            )
        ).resolve()

        self.threshold = float(
            os.getenv(
                "MODEL_THRESHOLD",
                "0.5",
            )
        )

        self.data_mode = (
            data_mode
            or os.getenv("APP_DATA_MODE")
            or os.getenv("APP_MODE")
            or "DEMO"
        ).upper()

        self.segmenter = OilSpillSegmenter(
            model_path=str(self.model_path),
            threshold=self.threshold,
        )

        # --------------------------------------------------------------
        # DRIFT MODEL
        # --------------------------------------------------------------

        self.drift_model = LagrangianDriftModel(
            wind_factor=float(
                os.getenv(
                    "WIND_LEEWAY_FACTOR",
                    "0.03",
                )
            ),
            wind_deflection_deg=float(
                os.getenv(
                    "WIND_DEFLECTION_DEG",
                    "5.0",
                )
            ),
            eddy_diffusivity=float(
                os.getenv(
                    "EDDY_DIFFUSIVITY",
                    "2.5",
                )
            ),
        )

        # --------------------------------------------------------------
        # AIS TRAJECTORY ENGINE
        # --------------------------------------------------------------

        self.trajectory_engine = AISTrajectoryEngine(
            max_speed_knots=45.0
        )

        # --------------------------------------------------------------
        # IN-MEMORY RESULTS
        # --------------------------------------------------------------

        self.spills: Dict[int, Dict[str, Any]] = {}
        self.simulations: Dict[int, Dict[str, Any]] = {}
        self.analyses: Dict[str, Dict[str, Any]] = {}

        self._spill_counter = 1000
        self._simulation_counter = 5000

        # --------------------------------------------------------------
        # REAL HISTORICAL SCENE
        # --------------------------------------------------------------

        self.real_scene = {
            "scene_id": "GOM_S1A_20180926_REAL",
            "name": (
                "Sentinel-1A Gulf of Mexico — 26 Sep 2018"
            ),
            "region": "Northern Gulf of Mexico",

            # Dataset scene / SAR observation timestamp.
            "acquisition_time": (
                "2018-09-26T14:24:00Z"
            ),

            "satellite": "Sentinel-1A",
            "polarization": "VV",

            # Geographic scene extent:
            # [min_lon, min_lat, max_lon, max_lat]
            "bbox": [
                -89.42,
                28.77,
                -88.90,
                29.01,
            ],

            "center_lat": 28.9047446258,
            "center_lon": -89.0242701655,

            # ERA5 values near the spill region.
            #
            # These are wind values, not observed ocean currents.
            "environmental": {
                "current_uo_ms": 0.22,
                "current_vo_ms": -0.15,
                "wind_u10_ms": 1.697,
                "wind_v10_ms": 1.591,
                "wave_height_m": 0.0,
                "sea_temp_c": 0.0,
            },

            "data_source": (
                "Sentinel-1 Dataset 2 / Zenodo 4672426"
            ),

            "ais_source": (
                "NOAA MarineCadastre Nationwide AIS 2018"
            ),

            "wind_source": (
                "Copernicus ERA5 reanalysis"
            ),

            # ----------------------------------------------------------
            # LOCAL REAL DATA FILES
            # ----------------------------------------------------------

            "raster_path": (
                self.project_root
                / "data"
                / "sentinel1"
                / "real"
                / "2018_09_26.tif"
            ),

            "ais_path": (
                self.project_root
                / "data"
                / "ais"
                / "2018"
                / "ais_2018-09-26_scene.csv"
            ),

            "era5_path": (
                self.project_root
                / "data"
                / "era5"
                / "era5_2018-09-26.nc"
            ),
        }

        # --------------------------------------------------------------
        # DEMO SCENE
        # --------------------------------------------------------------

        # Kept for compatibility with the existing UI.
        #
        # It currently points to the same real-data processing pipeline,
        # but is labelled separately so the frontend does not break.
        self.demo_scene = {
            **self.real_scene,
            "scene_id": "GOM_S1A_20260828",
            "name": "Gulf of Mexico Demonstration Scene",
            "region": "Gulf of Mexico",
            "acquisition_time": "2026-08-28T06:14:22Z",
            "center_lat": 29.04503,
            "center_lon": -88.84503,
            "raster_path": None,
            "era5_path": None,
            "ais_path": (
                self.project_root
                / "data"
                / "sample"
                / "S1A_IW_GRDH_1SDV_20260828T061422_GOM_MISSISSIPPI_ais.json"
            ),
        }

    # ==================================================================
    # MODEL STATUS / HEALTH
    # ==================================================================

    def model_status(self) -> Dict[str, Any]:
        """
        Returns the current deployed segmentation model status.
        """

        return {
            "name": "SAROilSpillUNet",
            "task": (
                "Sentinel-1 SAR oil spill segmentation"
            ),
            "checkpoint_path": str(
                self.model_path
            ),
            "checkpoint_exists": (
                self.model_path.exists()
            ),
            "loaded": (
                self.segmenter.model is not None
            ),
            "device": str(
                self.segmenter.device
            ),
            "threshold": (
                self.segmenter.threshold
            ),
            "fallback": None,
            "load_error": (
                self.segmenter.load_error
            ),
        }

    def health(self) -> Dict[str, Any]:
        """
        Backwards-compatible health method.
        """
        return self.model_status()

    def validate_credentials(self) -> Dict[str, Any]:
        """
        Reports availability of external/local data resources.

        Credentials are not required for the already-downloaded
        historical scene.
        """

        if self.data_mode == "DEMO":
            return {
                "valid": True,
                "mode": "DEMO",
                "message": (
                    "DEMO mode active: using bundled local sample data. "
                    "Live API credentials are not required."
                ),
            }

        live_credentials = {
            "COPERNICUS_USERNAME": bool(os.getenv("COPERNICUS_USERNAME")),
            "COPERNICUS_CLIENT_SECRET": bool(os.getenv("COPERNICUS_CLIENT_SECRET")),
            "COPERNICUS_MARINE_USERNAME": bool(os.getenv("COPERNICUS_MARINE_USERNAME")),
            "CDS_API_KEY": bool(os.getenv("CDS_API_KEY")),
        }

        missing_credentials = [
            name
            for name, available in live_credentials.items()
            if not available
        ]

        status = {
            "copernicus": {
                "required": True,
                "available": bool(
                    os.getenv(
                        "COPERNICUS_CLIENT_ID"
                    )
                    or os.getenv(
                        "COPERNICUS_TOKEN"
                    )
                ),
                "purpose": (
                    "Optional live Sentinel-1 acquisition"
                ),
            },

            "era5": {
                "required": False,
                "available": Path(
                    self.real_scene[
                        "era5_path"
                    ]
                ).exists(),
                "purpose": (
                    "ERA5 historical wind forcing"
                ),
            },

            "marinecadastre": {
                "required": False,
                "available": Path(
                    self.real_scene[
                        "ais_path"
                    ]
                ).exists(),
                "purpose": (
                    "Historical AIS vessel trajectories"
                ),
            },

            "sentinel1": {
                "required": True,
                "available": Path(
                    self.real_scene[
                        "raster_path"
                    ]
                ).exists(),
                "purpose": (
                    "Real Sentinel-1 SAR scene"
                ),
            },

            "model_checkpoint": {
                "required": True,
                "available": (
                    self.model_path.exists()
                ),
                "purpose": (
                    "Trained U-Net segmentation model"
                ),
            },
        }

        missing = [
            name
            for name, details in status.items()
            if details.get("required")
            and not details.get("available")
        ] + missing_credentials

        return {
            "valid": len(missing) == 0,
            "mode": "REAL",
            "missing_credentials": missing,
            **status,
        }

    # ==================================================================
    # SCENES
    # ==================================================================

    def get_scenes(
        self,
    ) -> List[Dict[str, Any]]:
        """
        Returns scenes available to the frontend.
        """

        if self.data_mode == "DEMO":
            return [
                self._scene_for_response(
                    self.demo_scene
                ),
                self._scene_for_response(
                    self.real_scene
                ),
            ]

        return [
            self._scene_for_response(
                self.real_scene
            ),
            self._scene_for_response(
                self.demo_scene
            ),
        ]

    def _scene_for_response(
        self,
        scene: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Removes local filesystem paths before sending
        scene information to the browser.
        """

        result = dict(scene)

        for key in [
            "raster_path",
            "ais_path",
            "era5_path",
        ]:
            result.pop(
                key,
                None,
            )

        return result

    def get_scene_by_id(
        self,
        scene_id: str,
    ) -> Optional[Dict[str, Any]]:
        if scene_id == self.real_scene[
            "scene_id"
        ]:
            return self._scene_for_response(
                self.real_scene
            )

        if scene_id == self.demo_scene[
            "scene_id"
        ]:
            return self._scene_for_response(
                self.demo_scene
            )

        return None

    def _get_scene_internal(
        self,
        scene_id: str,
    ) -> Dict[str, Any]:
        if scene_id == self.real_scene[
            "scene_id"
        ]:
            return self.real_scene

        if scene_id == self.demo_scene[
            "scene_id"
        ]:
            return self.demo_scene

        raise ValueError(
            f"Scene not found: {scene_id}"
        )

    def _demo_detection(
        self,
        scene: Dict[str, Any],
        confidence_threshold: float,
        polarization: str,
    ) -> Dict[str, Any]:
        """
        Small deploy-friendly DEMO detection used when raw Sentinel-1
        rasters are not shipped with the Git repository.
        """

        center_lat = float(scene["center_lat"])
        center_lon = float(scene["center_lon"])
        half_lat = 0.035
        half_lon = 0.055

        polygon = [
            [center_lon - half_lon, center_lat - half_lat],
            [center_lon + half_lon, center_lat - half_lat],
            [center_lon + half_lon, center_lat + half_lat],
            [center_lon - half_lon, center_lat + half_lat],
            [center_lon - half_lon, center_lat - half_lat],
        ]

        width_km = haversine_distance(
            center_lat,
            center_lon - half_lon,
            center_lat,
            center_lon + half_lon,
        )
        height_km = haversine_distance(
            center_lat - half_lat,
            center_lon,
            center_lat + half_lat,
            center_lon,
        )
        area_km2 = width_km * height_km

        self._spill_counter += 1
        spill_id = self._spill_counter

        result = {
            "spill_id": spill_id,
            "scene_id": scene["scene_id"],
            "detection_time": scene["acquisition_time"],
            "geometry": {
                "has_detection": True,
                "centroid": [center_lat, center_lon],
                "area_km2": round(area_km2, 3),
                "area_hectares": round(area_km2 * 100.0, 2),
                "perimeter_km": round(2.0 * (width_km + height_km), 3),
                "bbox": [
                    center_lon - half_lon,
                    center_lat - half_lat,
                    center_lon + half_lon,
                    center_lat + half_lat,
                ],
                "coordinates": polygon,
                "orientation_deg": 125.0,
                "confidence": max(0.82, confidence_threshold),
                "pixel_count": 1842,
            },
            "dataset_mode": "DEMO",
            "polarization": polarization,
            "disclaimer": (
                "Demo detection uses bundled sample geometry so the Git "
                "deployment remains lightweight. Real detections require "
                "a Sentinel-1 raster supplied in REAL mode."
            ),
        }

        self.spills[spill_id] = result
        return result

    # ==================================================================
    # SENTINEL-1 RASTER
    # ==================================================================

    def _load_real_raster(
        self,
        scene: Dict[str, Any],
    ) -> Tuple[
        np.ndarray,
        Dict[str, Any],
    ]:
        """
        Loads the real Sentinel-1 GeoTIFF.

        Returns:
            image
            raster metadata
        """

        raster_path = Path(
            scene["raster_path"]
        )

        if not raster_path.exists():
            raise ValueError(
                "Sentinel-1 raster not found: "
                f"{raster_path}"
            )

        with rasterio.open(
            raster_path
        ) as src:

            image = src.read(
                1
            ).astype(
                np.float32
            )

            metadata = {
                "crs": src.crs,
                "transform": src.transform,
                "width": src.width,
                "height": src.height,
                "bounds": src.bounds,
                "nodata": src.nodata,
            }

        image = np.nan_to_num(
            image,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )

        return (
            image,
            metadata,
        )

    # ==================================================================
    # U-NET INFERENCE
    # ==================================================================

    def _run_unet(
        self,
        image: np.ndarray,
        confidence_threshold: float,
    ) -> Tuple[
        np.ndarray,
        np.ndarray,
    ]:
        """
        Runs the trained U-Net.

        Returns:
            probability raster
            binary mask
        """

        if image.ndim != 2:
            raise ValueError(
                "Expected 2D SAR raster, got "
                f"{image.shape}"
            )

        result = self.segmenter.predict(
            image[
                np.newaxis,
                ...
            ]
        )

        if isinstance(
            result,
            dict,
        ):

            probability = result.get(
                "probability"
            )

            if probability is None:
                probability = result.get(
                    "probabilities"
                )

            mask = result.get(
                "mask"
            )

            if (
                probability is None
                and mask is not None
            ):
                probability = np.asarray(
                    mask,
                    dtype=np.float32,
                )

            if probability is None:
                raise ValueError(
                    "U-Net inference returned "
                    "no probability raster."
                )

            probability = np.asarray(
                probability,
                dtype=np.float32,
            )

            if probability.ndim == 3:
                probability = probability.squeeze()

            if mask is None:

                mask = (
                    probability
                    >= confidence_threshold
                )

            else:

                mask = np.asarray(
                    mask
                )

                if mask.ndim == 3:
                    mask = mask.squeeze()

                mask = (
                    mask > 0
                )

        else:

            probability = np.asarray(
                result,
                dtype=np.float32,
            )

            if probability.ndim == 3:
                probability = probability.squeeze()

            mask = (
                probability
                >= confidence_threshold
            )

        probability = np.nan_to_num(
            probability,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )

        mask = np.asarray(
            mask,
            dtype=bool,
        )

        if probability.shape != image.shape:
            raise ValueError(
                "U-Net probability raster shape "
                f"{probability.shape} does not match "
                f"input raster shape {image.shape}."
            )

        if mask.shape != image.shape:
            raise ValueError(
                "U-Net mask shape "
                f"{mask.shape} does not match "
                f"input raster shape {image.shape}."
            )

        return (
            probability,
            mask,
        )

    # ==================================================================
    # PIXEL → WGS84
    # ==================================================================

    def _pixel_to_lonlat(
        self,
        transform: Any,
        crs: Any,
        row: float,
        col: float,
    ) -> Tuple[
        float,
        float,
    ]:
        """
        Converts raster row/column to WGS84 lon/lat.
        """

        x, y = rasterio.transform.xy(
            transform,
            row,
            col,
            offset="center",
        )

        if str(crs).upper() in [
            "EPSG:4326",
            "EPSG:4326",
        ]:
            return (
                float(x),
                float(y),
            )

        transformer = Transformer.from_crs(
            crs,
            "EPSG:4326",
            always_xy=True,
        )

        lon, lat = transformer.transform(
            x,
            y,
        )

        return (
            float(lon),
            float(lat),
        )

    # ==================================================================
    # MASK GEOMETRY
    # ==================================================================

    def _mask_geometry(
        self,
        mask: np.ndarray,
        metadata: Dict[str, Any],
        confidence: float,
    ) -> Dict[str, Any]:
        """
        Converts the U-Net binary mask into geographic geometry.

        Uses:
            - real raster transform
            - real raster CRS
            - real pixel dimensions
            - physical pixel area
            - PCA orientation
            - radial boundary extraction
        """

        ys, xs = np.where(
            mask
        )

        # --------------------------------------------------------------
        # NO DETECTION
        # --------------------------------------------------------------

        if len(xs) == 0:

            corners = [
                self._pixel_to_lonlat(
                    metadata["transform"],
                    metadata["crs"],
                    0,
                    0,
                ),
                self._pixel_to_lonlat(
                    metadata["transform"],
                    metadata["crs"],
                    0,
                    metadata["width"] - 1,
                ),
                self._pixel_to_lonlat(
                    metadata["transform"],
                    metadata["crs"],
                    metadata["height"] - 1,
                    metadata["width"] - 1,
                ),
                self._pixel_to_lonlat(
                    metadata["transform"],
                    metadata["crs"],
                    metadata["height"] - 1,
                    0,
                ),
            ]

            lons = [
                p[0]
                for p in corners
            ]

            lats = [
                p[1]
                for p in corners
            ]

            return {
                "has_detection": False,
                "centroid": [
                    float(
                        sum(lats)
                        / len(lats)
                    ),
                    float(
                        sum(lons)
                        / len(lons)
                    ),
                ],
                "area_km2": 0.0,
                "area_hectares": 0.0,
                "perimeter_km": 0.0,
                "bbox": [
                    min(lons),
                    min(lats),
                    max(lons),
                    max(lats),
                ],
                "coordinates": [],
                "orientation_deg": 0.0,
                "confidence": 0.0,
                "pixel_count": 0,
            }

        # --------------------------------------------------------------
        # CENTROID
        # --------------------------------------------------------------

        mean_row = float(
            np.mean(ys)
        )

        mean_col = float(
            np.mean(xs)
        )

        centroid_lon, centroid_lat = (
            self._pixel_to_lonlat(
                metadata["transform"],
                metadata["crs"],
                mean_row,
                mean_col,
            )
        )

        # --------------------------------------------------------------
        # GEOGRAPHIC BBOX
        # --------------------------------------------------------------

        min_row = int(
            np.min(ys)
        )

        max_row = int(
            np.max(ys)
        )

        min_col = int(
            np.min(xs)
        )

        max_col = int(
            np.max(xs)
        )

        bbox_pixels = [
            (
                min_row,
                min_col,
            ),
            (
                min_row,
                max_col,
            ),
            (
                max_row,
                min_col,
            ),
            (
                max_row,
                max_col,
            ),
        ]

        bbox_points = [
            self._pixel_to_lonlat(
                metadata["transform"],
                metadata["crs"],
                row,
                col,
            )
            for row, col in bbox_pixels
        ]

        lons = [
            p[0]
            for p in bbox_points
        ]

        lats = [
            p[1]
            for p in bbox_points
        ]

        geo_bbox = [
            round(
                min(lons),
                6,
            ),
            round(
                min(lats),
                6,
            ),
            round(
                max(lons),
                6,
            ),
            round(
                max(lats),
                6,
            ),
        ]

        # --------------------------------------------------------------
        # SAMPLE PIXELS FOR PCA
        # --------------------------------------------------------------

        sample_size = min(
            len(xs),
            200000,
        )

        if len(xs) > sample_size:

            indices = np.linspace(
                0,
                len(xs) - 1,
                sample_size,
                dtype=np.int64,
            )

            xs_sample = xs[
                indices
            ]

            ys_sample = ys[
                indices
            ]

        else:

            xs_sample = xs
            ys_sample = ys

        # --------------------------------------------------------------
        # PCA IN PROJECTED CRS
        # --------------------------------------------------------------

        x_values = []
        y_values = []

        transform = metadata[
            "transform"
        ]

        for x_px, y_px in zip(
            xs_sample,
            ys_sample,
        ):

            x_geo, y_geo = (
                rasterio.transform.xy(
                    transform,
                    int(y_px),
                    int(x_px),
                    offset="center",
                )
            )

            x_values.append(
                float(x_geo)
            )

            y_values.append(
                float(y_geo)
            )

        orientation_deg = 0.0

        if len(
            x_values
        ) >= 2:

            coords = np.column_stack(
                [
                    np.asarray(
                        x_values
                    ),
                    np.asarray(
                        y_values
                    ),
                ]
            )

            coords = (
                coords
                - coords.mean(
                    axis=0
                )
            )

            covariance = np.cov(
                coords,
                rowvar=False,
            )

            eigenvalues, eigenvectors = (
                np.linalg.eigh(
                    covariance
                )
            )

            principal = (
                eigenvectors[
                    :,
                    np.argmax(
                        eigenvalues
                    ),
                ]
            )

            angle_math = math.degrees(
                math.atan2(
                    principal[1],
                    principal[0],
                )
            )

            orientation_deg = (
                90.0
                - angle_math
            ) % 180.0

        # --------------------------------------------------------------
        # REAL PIXEL AREA
        # --------------------------------------------------------------

        pixel_area_m2 = abs(
            float(
                transform.a
            )
            * float(
                transform.e
            )
        )

        area_km2 = (
            len(xs)
            * pixel_area_m2
            / 1_000_000.0
        )

        area_hectares = (
            area_km2
            * 100.0
        )

        # --------------------------------------------------------------
        # APPROXIMATE PERIMETER
        # --------------------------------------------------------------

        width_km = haversine_distance(
            centroid_lat,
            geo_bbox[0],
            centroid_lat,
            geo_bbox[2],
        )

        height_km = haversine_distance(
            geo_bbox[1],
            centroid_lon,
            geo_bbox[3],
            centroid_lon,
        )

        perimeter_km = (
            2.0
            * (
                width_km
                + height_km
            )
        )

        # --------------------------------------------------------------
        # RADIAL BOUNDARY
        # --------------------------------------------------------------

        num_bins = 48

        bins: Dict[
            int,
            Tuple[
                float,
                int,
                int,
            ],
        ] = {}

        for x_px, y_px in zip(
            xs_sample,
            ys_sample,
        ):

            angle = math.atan2(
                y_px - mean_row,
                x_px - mean_col,
            )

            bin_id = int(
                (
                    angle
                    + math.pi
                )
                / (
                    2.0
                    * math.pi
                )
                * num_bins
            ) % num_bins

            distance_sq = (
                (
                    x_px
                    - mean_col
                )
                ** 2
                + (
                    y_px
                    - mean_row
                )
                ** 2
            )

            previous = bins.get(
                bin_id
            )

            if (
                previous is None
                or distance_sq
                > previous[0]
            ):
                bins[
                    bin_id
                ] = (
                    distance_sq,
                    int(x_px),
                    int(y_px),
                )

        polygon = []

        for bin_id in sorted(
            bins
        ):

            _distance_sq, x_px, y_px = (
                bins[bin_id]
            )

            lon, lat = (
                self._pixel_to_lonlat(
                    metadata["transform"],
                    metadata["crs"],
                    y_px,
                    x_px,
                )
            )

            polygon.append(
                [
                    round(
                        lon,
                        6,
                    ),
                    round(
                        lat,
                        6,
                    ),
                ]
            )

        if len(
            polygon
        ) >= 3:

            if polygon[
                0
            ] != polygon[
                -1
            ]:
                polygon.append(
                    polygon[0]
                )

        return {
            "has_detection": True,

            "centroid": [
                round(
                    centroid_lat,
                    6,
                ),
                round(
                    centroid_lon,
                    6,
                ),
            ],

            "area_km2": round(
                area_km2,
                3,
            ),

            "area_hectares": round(
                area_hectares,
                2,
            ),

            "perimeter_km": round(
                perimeter_km,
                2,
            ),

            "bbox": geo_bbox,

            "coordinates": polygon,

            "orientation_deg": round(
                orientation_deg,
                1,
            ),

            "confidence": round(
                confidence,
                3,
            ),

            "pixel_count": int(
                len(xs)
            ),
        }

    # ==================================================================
    # SPILL DETECTION
    # ==================================================================

    def detect_spill(
        self,
        scene_id: str,
        confidence_threshold: float = 0.48,
        polarization: str = "VV",
    ) -> Dict[str, Any]:

        scene = (
            self._get_scene_internal(
                scene_id
            )
        )

        # --------------------------------------------------------------
        # REAL PRODUCTION SCENE
        # --------------------------------------------------------------

        if scene_id != self.real_scene[
            "scene_id"
        ]:
            return self._demo_detection(
                scene,
                confidence_threshold,
                polarization,
            )

        # --------------------------------------------------------------
        # LOAD SAR
        # --------------------------------------------------------------

        image, metadata = (
            self._load_real_raster(
                scene
            )
        )

        # --------------------------------------------------------------
        # U-NET
        # --------------------------------------------------------------

        probability, binary_mask = (
            self._run_unet(
                image,
                confidence_threshold,
            )
        )

        # --------------------------------------------------------------
        # DETECTION CONFIDENCE
        # --------------------------------------------------------------

        if binary_mask.any():

            detection_confidence = float(
                np.mean(
                    probability[
                        binary_mask
                    ]
                )
            )

        else:

            detection_confidence = float(
                np.max(
                    probability
                )
            )

        # --------------------------------------------------------------
        # GEOMETRY
        # --------------------------------------------------------------

        geometry = (
            self._mask_geometry(
                binary_mask,
                metadata,
                detection_confidence,
            )
        )

        # --------------------------------------------------------------
        # STORE SPILL
        # --------------------------------------------------------------

        self._spill_counter += 1

        spill_id = (
            self._spill_counter
        )

        result = {
            "spill_id": spill_id,

            "scene_id": scene_id,

            "detection_time": scene[
                "acquisition_time"
            ],

            "geometry": geometry,

            "dataset_mode": "REAL",

            "polarization": polarization,

            "disclaimer": (
                "Detection is produced by the "
                "trained Sentinel-1 U-Net "
                "segmentation model. A segmented "
                "SAR anomaly is not by itself "
                "proof of petroleum; independent "
                "validation is required."
            ),
        }

        self.spills[
            spill_id
        ] = result

        return result

    # ==================================================================
    # ERA5 WIND
    # ==================================================================

    def _load_era5_wind(
        self,
        scene: Dict[str, Any],
        lat: float,
        lon: float,
    ) -> Tuple[
        float,
        float,
        Dict[str, Any],
    ]:

        if not scene.get("era5_path"):
            raise ValueError(
                "ERA5 dataset not configured for this scene."
            )

        era5_path = Path(
            scene["era5_path"]
        )

        if not era5_path.exists():

            raise ValueError(
                "ERA5 dataset not found: "
                f"{era5_path}"
            )

        import xarray as xr

        ds = xr.open_dataset(
            era5_path
        )

        try:

            lat_name = (
                "latitude"
                if "latitude"
                in ds.coords
                else "lat"
            )

            lon_name = (
                "longitude"
                if "longitude"
                in ds.coords
                else "lon"
            )

            time_name = (
                "valid_time"
                if "valid_time"
                in ds.coords
                else "time"
            )

            point = ds.sel(
                {
                    lat_name: lat,
                    lon_name: lon,
                },
                method="nearest",
            )

            if (
                "u10"
                not in point
                or "v10"
                not in point
            ):

                raise ValueError(
                    "ERA5 file does not contain "
                    "u10/v10 wind variables."
                )

            u_values = np.asarray(
                point[
                    "u10"
                ].values,
                dtype=float,
            ).reshape(
                -1
            )

            v_values = np.asarray(
                point[
                    "v10"
                ].values,
                dtype=float,
            ).reshape(
                -1
            )

            times = np.asarray(
                point[
                    time_name
                ].values
            ).reshape(
                -1
            )

            u10 = float(
                np.nanmean(
                    u_values
                )
            )

            v10 = float(
                np.nanmean(
                    v_values
                )
            )

            wind_speed = math.sqrt(
                u10 ** 2
                + v10 ** 2
            )

            direction_to = (
                math.degrees(
                    math.atan2(
                        u10,
                        v10,
                    )
                )
                % 360.0
            )

            direction_from = (
                (
                    direction_to
                    + 180.0
                )
                % 360.0
            )

            return (
                u10,
                v10,
                {
                    "source": (
                        "Copernicus ERA5"
                    ),

                    "variable": (
                        "10m wind"
                    ),

                    "wind_speed_ms": round(
                        wind_speed,
                        3,
                    ),

                    "wind_direction_to_deg": round(
                        direction_to,
                        1,
                    ),

                    "wind_direction_from_deg": round(
                        direction_from,
                        1,
                    ),

                    "timestamps": [
                        str(t)
                        for t in times
                    ],
                },
            )

        finally:

            ds.close()

    # ==================================================================
    # DRIFT
    # ==================================================================

    def run_drift(
        self,
        spill_id: int,
        mode: str = "BACKWARD",
        drift_hours: float = 12.0,
        timestep_minutes: float = 30.0,
        num_particles: int = 60,
        current_uo: Optional[float] = None,
        current_vo: Optional[float] = None,
        wind_u: Optional[float] = None,
        wind_v: Optional[float] = None,
    ) -> Dict[str, Any]:

        spill = self.spills.get(
            spill_id
        )

        if spill is None:

            raise ValueError(
                f"Spill {spill_id} not found"
            )

        scene = (
            self._get_scene_internal(
                spill["scene_id"]
            )
        )

        centroid = tuple(
            spill[
                "geometry"
            ][
                "centroid"
            ]
        )

        polygon = spill[
            "geometry"
        ][
            "coordinates"
        ]

        # --------------------------------------------------------------
        # ERA5 WIND
        # --------------------------------------------------------------

        if (
            wind_u is None
            or wind_v is None
        ):

            try:
                (
                    era5_u,
                    era5_v,
                    era5_meta,
                ) = self._load_era5_wind(
                    scene,
                    centroid[0],
                    centroid[1],
                )
            except ValueError:
                environmental = scene.get("environmental", {})
                era5_u = float(environmental.get("wind_u10_ms", 0.0))
                era5_v = float(environmental.get("wind_v10_ms", 0.0))
                era5_meta = {
                    "source": "scene metadata fallback",
                    "variable": "10m wind",
                }

        else:

            era5_u = float(
                wind_u
            )

            era5_v = float(
                wind_v
            )

            era5_meta = {
                "source": (
                    "API override"
                ),
                "variable": (
                    "10m wind"
                ),
            }

        # --------------------------------------------------------------
        # OCEAN CURRENT
        # --------------------------------------------------------------

        if (
            current_uo is None
            or current_vo is None
        ):

            current_u = (
                self.drift_model
                .default_current_u
            )

            current_v = (
                self.drift_model
                .default_current_v
            )

            current_source = (
                "Lagrangian model default "
                "(not an observed current field)"
            )

        else:

            current_u = float(
                current_uo
            )

            current_v = float(
                current_vo
            )

            current_source = (
                "API-provided current"
            )

        # --------------------------------------------------------------
        # SIMULATION
        # --------------------------------------------------------------

        sim = (
            self.drift_model.simulate(
                centroid=centroid,
                spill_polygon=polygon,
                observation_time_iso=spill[
                    "detection_time"
                ],
                drift_hours=drift_hours,
                timestep_minutes=timestep_minutes,
                num_particles=num_particles,
                mode=mode,
                seed=42,
                current_uv=(
                    current_u,
                    current_v,
                ),
                wind_uv=(
                    era5_u,
                    era5_v,
                ),
            )
        )

        self._simulation_counter += 1

        simulation_id = (
            self._simulation_counter
        )

        sim[
            "simulation_id"
        ] = simulation_id

        sim[
            "spill_id"
        ] = spill_id

        # --------------------------------------------------------------
        # ENVIRONMENTAL METADATA
        # --------------------------------------------------------------

        sim[
            "environmental_parameters"
        ][
            "wind_source"
        ] = era5_meta[
            "source"
        ]

        sim[
            "environmental_parameters"
        ][
            "current_source"
        ] = current_source

        sim[
            "environmental_parameters"
        ][
            "current_observation_status"
        ] = (
            "NOT OBSERVED"
            if "default"
            in current_source.lower()
            else "PROVIDED"
        )

        sim[
            "environmental_parameters"
        ][
            "era5_wind_metadata"
        ] = era5_meta

        sim[
            "environmental_parameters"
        ][
            "forcing_summary"
        ] = (
            "ERA5 10 m wind + model current default"
            if "default"
            in current_source.lower()
            else "ERA5 10 m wind + supplied current"
        )

        sim[
            "disclaimer"
        ] = (
            "Backward Lagrangian particle "
            "simulation using real ERA5 10 m "
            "wind forcing. The current component "
            "is a model default unless an observed "
            "current field is explicitly provided. "
            "The probable origin is an uncertainty "
            "ensemble, not a confirmed discharge "
            "location."
        )

        self.simulations[
            simulation_id
        ] = sim

        return sim

    # ==================================================================
    # MARINECADASTRE AIS
    # ==================================================================

    def _load_marinecadastre_ais(
        self,
        scene: Dict[str, Any],
    ) -> List[Dict[str, Any]]:

        ais_path = Path(scene["ais_path"])

        if not ais_path.exists():

            raise ValueError(
                "MarineCadastre AIS file not found: "
                f"{ais_path}"
            )

        if ais_path.suffix.lower() == ".json":
            import json

            with ais_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)

            return data if isinstance(data, list) else []

        rows: List[Dict[str, Any]] = []

        with ais_path.open(
            "r",
            encoding="utf-8",
            errors="replace",
            newline="",
        ) as handle:

            reader = csv.DictReader(
                handle
            )

            for raw in reader:

                try:

                    lat = float(
                        raw[
                            "latitude"
                        ]
                    )

                    lon = float(
                        raw[
                            "longitude"
                        ]
                    )

                except (
                    ValueError,
                    TypeError,
                    KeyError,
                ):

                    continue

                if not (
                    -90.0
                    <= lat
                    <= 90.0
                    and -180.0
                    <= lon
                    <= 180.0
                ):
                    continue

                rows.append(
                    {
                        "mmsi": str(
                            raw.get(
                                "mmsi",
                                "",
                            )
                        ),

                        "timestamp": (
                            raw.get(
                                "base_date_time",
                                "",
                            )
                        ),

                        "latitude": lat,

                        "longitude": lon,

                        "sog": self._safe_float(
                            raw.get(
                                "sog"
                            )
                        ),

                        "cog": self._safe_float(
                            raw.get(
                                "cog"
                            )
                        ),

                        "heading": self._safe_float(
                            raw.get(
                                "heading"
                            )
                        ),

                        "vessel_name": (
                            raw.get(
                                "vessel_name"
                            )
                            or "UNKNOWN"
                        ),

                        "imo": (
                            raw.get(
                                "imo"
                            )
                            or ""
                        ),

                        "call_sign": (
                            raw.get(
                                "call_sign"
                            )
                            or ""
                        ),

                        "vessel_type": (
                            raw.get(
                                "vessel_type"
                            )
                            or "UNKNOWN"
                        ),

                        "status": (
                            raw.get(
                                "status"
                            )
                            or ""
                        ),

                        "length": self._safe_float(
                            raw.get(
                                "length"
                            )
                        ),

                        "width": self._safe_float(
                            raw.get(
                                "width"
                            )
                        ),

                        "draft": self._safe_float(
                            raw.get(
                                "draft"
                            )
                        ),

                        "cargo": (
                            raw.get(
                                "cargo"
                            )
                            or ""
                        ),

                        "transceiver": (
                            raw.get(
                                "transceiver"
                            )
                            or ""
                        ),
                    }
                )

        return rows

    @staticmethod
    def _safe_float(
        value: Any,
    ) -> float:

        try:

            if (
                value is None
                or value == ""
            ):
                return 0.0

            result = float(
                value
            )

            if not math.isfinite(
                result
            ):
                return 0.0

            return result

        except (
            ValueError,
            TypeError,
        ):

            return 0.0

    # ==================================================================
    # VESSEL ATTRIBUTION
    # ==================================================================

    def rank_candidates(
        self,
        spill_id: int,
        simulation_id: Optional[int] = None,
        weight_spatial: float = 0.35,
        weight_temporal: float = 0.25,
        weight_trajectory: float = 0.25,
        weight_consistency: float = 0.15,
    ) -> Dict[str, Any]:

        spill = self.spills.get(
            spill_id
        )

        if spill is None:

            raise ValueError(
                f"Spill {spill_id} not found"
            )

        # --------------------------------------------------------------
        # SELECT SIMULATION
        # --------------------------------------------------------------

        if simulation_id is None:

            matching_ids = [
                sid
                for sid, sim
                in self.simulations.items()
                if sim[
                    "spill_id"
                ] == spill_id
            ]

            simulation_id = max(
                matching_ids,
                default=None,
            )

        if simulation_id is None:

            raise ValueError(
                "No drift simulation exists "
                "for this spill."
            )

        simulation = self.simulations.get(
            simulation_id
        )

        if simulation is None:

            raise ValueError(
                f"Simulation {simulation_id} not found"
            )

        # --------------------------------------------------------------
        # ORIGIN
        # --------------------------------------------------------------

        origin = simulation[
            "probable_origin"
        ]

        origin_centroid = tuple(
            origin[
                "centroid"
            ]
        )

        origin_radius = float(
            origin[
                "uncertainty_radius_km"
            ]
        )

        release_window = origin[
            "estimated_release_window"
        ]

        # --------------------------------------------------------------
        # MARINECADASTRE AIS
        # --------------------------------------------------------------

        scene = (
            self._get_scene_internal(
                spill["scene_id"]
            )
        )

        raw_ais = (
            self._load_marinecadastre_ais(
                scene
            )
        )

        if len(
            raw_ais
        ) == 0:

            raise ValueError(
                "No valid MarineCadastre AIS "
                "records were found for this scene."
            )

        # --------------------------------------------------------------
        # TRAJECTORY RECONSTRUCTION
        # --------------------------------------------------------------

        trajectories = (
            self.trajectory_engine
            .reconstruct_trajectories(
                raw_points=raw_ais,

                origin_centroid=(
                    origin_centroid
                ),

                origin_uncertainty_radius_km=(
                    origin_radius
                ),

                release_window_start=(
                    release_window[
                        "start_time"
                    ]
                ),

                release_window_end=(
                    release_window[
                        "end_time"
                    ]
                ),
            )
        )

        if len(
            trajectories
        ) == 0:

            raise ValueError(
                "MarineCadastre AIS data did not "
                "produce any reconstructable "
                "multi-point vessel trajectories."
            )

        # --------------------------------------------------------------
        # EXPLAINABLE SCORER
        # --------------------------------------------------------------

        scorer = (
            ExplainableAttributionScorer(
                weight_spatial=(
                    weight_spatial
                ),
                weight_temporal=(
                    weight_temporal
                ),
                weight_trajectory=(
                    weight_trajectory
                ),
                weight_consistency=(
                    weight_consistency
                ),
            )
        )

        scored = scorer.rank_candidates(
            trajectories,
            origin_radius,
        )

        # --------------------------------------------------------------
        # CAUSALITY CHECK
        # --------------------------------------------------------------

        observation_dt = (
            datetime.fromisoformat(
                spill[
                    "detection_time"
                ].replace(
                    "Z",
                    "+00:00",
                )
            )
        )

        for candidate in scored:

            cpa_timestamp = candidate[
                "metrics"
            ].get(
                "cpa_timestamp"
            )

            try:

                cpa_dt = (
                    datetime.fromisoformat(
                        cpa_timestamp.replace(
                            "Z",
                            "+00:00",
                        )
                    )
                )

            except (
                ValueError,
                AttributeError,
            ):

                candidate[
                    "causality_flag"
                ] = "UNKNOWN"

                continue

            if cpa_dt > observation_dt:

                candidate[
                    "causality_flag"
                ] = (
                    "POST-OBSERVATION CPA"
                )

                candidate[
                    "evidence_narrative"
                ].append(
                    "Causality Check: Closest "
                    "approach occurred after the "
                    "Sentinel-1 observation; this "
                    "spatial correlation cannot by "
                    "itself establish that the vessel "
                    "caused the observed slick."
                )

            else:

                candidate[
                    "causality_flag"
                ] = (
                    "PRE/AT-OBSERVATION CPA"
                )

        # --------------------------------------------------------------
        # PRIORITY COUNTS
        # --------------------------------------------------------------

        high_count = sum(
            1
            for item in scored
            if item[
                "priority_level"
            ]
            == "HIGH PRIORITY CANDIDATE"
        )

        medium_count = sum(
            1
            for item in scored
            if item[
                "priority_level"
            ]
            == "MEDIUM PRIORITY CANDIDATE"
        )

        # --------------------------------------------------------------
        # TOP 20
        # --------------------------------------------------------------

        top_candidates = scored[
            :20
        ]

        # --------------------------------------------------------------
        # RESULT
        # --------------------------------------------------------------

        result = {
            "spill_id": spill_id,

            "scene_id": spill[
                "scene_id"
            ],

            "analysis_timestamp": (
                datetime.now(
                    timezone.utc
                ).isoformat()
            ),

            "total_candidates": len(
                scored
            ),

            "high_priority_count": (
                high_count
            ),

            "medium_priority_count": (
                medium_count
            ),

            "top_candidates": (
                top_candidates
            ),

            "weights_used": {
                "spatial": weight_spatial,
                "temporal": weight_temporal,
                "trajectory": weight_trajectory,
                "consistency": weight_consistency,
            },

            "attribution_disclaimer": (
                "MarineCadastre AIS tracks are used "
                "as decision-support evidence only. "
                "Ranking combines spatial proximity, "
                "temporal alignment, trajectory "
                "geometry and vessel kinematics. "
                "A high score does not establish "
                "legal responsibility or definitive "
                "discharge causality. Post-observation "
                "closest approaches are explicitly "
                "flagged."
            ),
        }

        return result

    # ==================================================================
    # FULL END-TO-END PIPELINE
    # ==================================================================

    def run_full_analysis(
        self,
        scene_id: str,
        drift_hours: float = 12.0,
        num_particles: int = 60,
        weight_spatial: float = 0.35,
        weight_temporal: float = 0.25,
        weight_trajectory: float = 0.25,
        weight_consistency: float = 0.15,
    ) -> Dict[str, Any]:

        # --------------------------------------------------------------
        # STEP 1 — SAR + U-NET
        # --------------------------------------------------------------

        detection = (
            self.detect_spill(
                scene_id=scene_id,
                confidence_threshold=(
                    self.threshold
                ),
                polarization="VV",
            )
        )

        # --------------------------------------------------------------
        # STEP 2 — LAGRANGIAN BACKTRACKING
        # --------------------------------------------------------------

        drift = (
            self.run_drift(
                spill_id=(
                    detection[
                        "spill_id"
                    ]
                ),
                mode="BACKWARD",
                drift_hours=(
                    drift_hours
                ),
                timestep_minutes=30.0,
                num_particles=(
                    num_particles
                ),
            )
        )

        # --------------------------------------------------------------
        # STEP 3 — MARINECADASTRE AIS ATTRIBUTION
        # --------------------------------------------------------------

        attribution = (
            self.rank_candidates(
                spill_id=(
                    detection[
                        "spill_id"
                    ]
                ),

                simulation_id=(
                    drift[
                        "simulation_id"
                    ]
                ),

                weight_spatial=(
                    weight_spatial
                ),

                weight_temporal=(
                    weight_temporal
                ),

                weight_trajectory=(
                    weight_trajectory
                ),

                weight_consistency=(
                    weight_consistency
                ),
            )
        )

        # --------------------------------------------------------------
        # ANALYSIS ID
        # --------------------------------------------------------------

        now = datetime.now(
            timezone.utc
        )

        analysis_id = (
            "AEGIS-"
            + now.strftime(
                "%Y%m%dT%H%M%S"
            )
            + "-"
            + uuid.uuid4()
            .hex[:6]
            .upper()
        )

        result = {
            "analysis_id": analysis_id,

            "scene_id": scene_id,

            "timestamp": (
                datetime.now(
                    timezone.utc
                ).isoformat()
            ),

            "status": "COMPLETED",

            "app_mode": "REAL",

            "detection": detection,

            "drift": drift,

            "attribution": attribution,
        }

        self.analyses[
            analysis_id
        ] = result

        return result

    # ==================================================================
    # MAP LAYERS
    # ==================================================================

    def get_map_layers(
        self,
        scene_id: str,
    ) -> Dict[str, Any]:

        scene = (
            self._get_scene_internal(
                scene_id
            )
        )

        # --------------------------------------------------------------
        # SCENE BOUNDING BOX
        # --------------------------------------------------------------

        min_lon = scene[
            "bbox"
        ][0]

        min_lat = scene[
            "bbox"
        ][1]

        max_lon = scene[
            "bbox"
        ][2]

        max_lat = scene[
            "bbox"
        ][3]

        layers = {
            "scene_bbox": {
                "type": "Feature",

                "geometry": {
                    "type": "Polygon",

                    "coordinates": [[

                        [
                            min_lon,
                            min_lat,
                        ],

                        [
                            max_lon,
                            min_lat,
                        ],

                        [
                            max_lon,
                            max_lat,
                        ],

                        [
                            min_lon,
                            max_lat,
                        ],

                        [
                            min_lon,
                            min_lat,
                        ],

                    ]],
                },

                "properties": {
                    "scene_id": scene_id,
                    "satellite": scene[
                        "satellite"
                    ],
                    "polarization": scene[
                        "polarization"
                    ],
                },
            }
        }

        # --------------------------------------------------------------
        # IF A SPILL EXISTS FOR THIS SCENE,
        # INCLUDE THE DETECTION POLYGON.
        # --------------------------------------------------------------

        matching_spills = [
            spill
            for spill
            in self.spills.values()
            if spill[
                "scene_id"
            ] == scene_id
        ]

        if matching_spills:

            latest_spill = matching_spills[
                -1
            ]

            geometry = latest_spill[
                "geometry"
            ]

            coordinates = geometry.get(
                "coordinates",
                [],
            )

            if len(
                coordinates
            ) >= 4:

                layers[
                    "spill_detection"
                ] = {
                    "type": "Feature",

                    "geometry": {
                        "type": "Polygon",

                        "coordinates": [
                            coordinates
                        ],
                    },

                    "properties": {
                        "spill_id": (
                            latest_spill[
                                "spill_id"
                            ]
                        ),

                        "confidence": (
                            geometry[
                                "confidence"
                            ]
                        ),

                        "area_km2": (
                            geometry[
                                "area_km2"
                            ]
                        ),

                        "orientation_deg": (
                            geometry[
                                "orientation_deg"
                            ]
                        ),
                    },
                }

        # --------------------------------------------------------------
        # IF A DRIFT SIMULATION EXISTS,
        # INCLUDE ORIGIN + PARTICLE TRACKS.
        # --------------------------------------------------------------

        matching_simulations = [
            sim
            for sim
            in self.simulations.values()
            if sim[
                "spill_id"
            ]
            in [
                spill[
                    "spill_id"
                ]
                for spill
                in matching_spills
            ]
        ]

        if matching_simulations:

            latest_simulation = (
                matching_simulations[
                    -1
                ]
            )

            origin = latest_simulation[
                "probable_origin"
            ]

            origin_lat = (
                origin[
                    "centroid"
                ][0]
            )

            origin_lon = (
                origin[
                    "centroid"
                ][1]
            )

            layers[
                "probable_origin"
            ] = {
                "type": "Feature",

                "geometry": {
                    "type": "Point",

                    "coordinates": [
                        origin_lon,
                        origin_lat,
                    ],
                },

                "properties": {
                    "simulation_id": (
                        latest_simulation[
                            "simulation_id"
                        ]
                    ),

                    "uncertainty_radius_km": (
                        origin[
                            "uncertainty_radius_km"
                        ]
                    ),
                },
            }

            uncertainty_polygon = (
                origin.get(
                    "uncertainty_polygon",
                    [],
                )
            )

            if len(
                uncertainty_polygon
            ) >= 4:

                layers[
                    "origin_uncertainty"
                ] = {
                    "type": "Feature",

                    "geometry": {
                        "type": "Polygon",

                        "coordinates": [
                            uncertainty_polygon
                        ],
                    },

                    "properties": {
                        "radius_km": (
                            origin[
                                "uncertainty_radius_km"
                            ]
                        ),
                    },
                }

            particle_tracks = (
                latest_simulation.get(
                    "particle_trajectories",
                    [],
                )
            )

            if particle_tracks:

                layers[
                    "drift_particles"
                ] = {
                    "type": "FeatureCollection",

                    "features": [
                        {
                            "type": "Feature",

                            "geometry": {
                                "type": "LineString",

                                "coordinates": track,
                            },

                            "properties": {
                                "particle_index": idx,
                            },
                        }

                        for idx, track
                        in enumerate(
                            particle_tracks
                        )

                        if len(track) >= 2
                    ],
                }

        # --------------------------------------------------------------
        # VESSEL TRACKS
        # --------------------------------------------------------------

        matching_attributions = []

        for analysis in (
            self.analyses.values()
        ):

            if analysis.get(
                "scene_id"
            ) == scene_id:

                matching_attributions.append(
                    analysis
                )

        if matching_attributions:

            latest_analysis = (
                matching_attributions[
                    -1
                ]
            )

            attribution = latest_analysis.get(
                "attribution"
            )

            if attribution:

                vessel_features = []

                for candidate in attribution.get(
                    "top_candidates",
                    [],
                ):

                    track = candidate.get(
                        "track_coordinates",
                        [],
                    )

                    if len(
                        track
                    ) < 2:

                        continue

                    vessel_features.append(
                        {
                            "type": "Feature",

                            "geometry": {
                                "type": "LineString",

                                "coordinates": track,
                            },

                            "properties": {
                                "rank": candidate.get(
                                    "rank"
                                ),

                                "mmsi": candidate.get(
                                    "mmsi"
                                ),

                                "vessel_name": candidate.get(
                                    "vessel_name"
                                ),

                                "composite_score": candidate.get(
                                    "composite_score"
                                ),

                                "priority_level": candidate.get(
                                    "priority_level"
                                ),

                                "causality_flag": candidate.get(
                                    "causality_flag",
                                    "UNKNOWN",
                                ),
                            },
                        }
                    )

                if vessel_features:

                    layers[
                        "vessel_tracks"
                    ] = {
                        "type": "FeatureCollection",

                        "features": vessel_features,
                    }

        return layers

    # ==================================================================
    # GENERIC MODEL PREDICTION
    # ==================================================================

    def predict(
        self,
        image: np.ndarray,
    ) -> Dict[str, Any]:

        if image is None:

            raise ValueError(
                "Input SAR image is required."
            )

        image = np.asarray(
            image,
            dtype=np.float32,
        )

        if image.ndim == 2:

            image = image[
                np.newaxis,
                ...
            ]

        if image.ndim != 3:

            raise ValueError(
                "Expected SAR image with "
                "2 or 3 dimensions, got "
                f"{image.shape}"
            )

        if image.shape[0] != 1:

            image = image[
                :1
            ]

        image = np.nan_to_num(
            image,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )

        prediction = (
            self.segmenter.predict(
                image
            )
        )

        if isinstance(
            prediction,
            dict,
        ):

            return prediction

        return {
            "mask": np.asarray(
                prediction
            ),

            "threshold": (
                self.threshold
            ),
        }


# ======================================================================
# SINGLE SERVICE INSTANCE
# ======================================================================

pipeline_service = (
    OilSpillPipelineService()
)

PipelineService = OilSpillPipelineService
