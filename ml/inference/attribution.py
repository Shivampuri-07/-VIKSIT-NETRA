import pandas as pd
import numpy as np
import xarray as xr

AIS_FILE = "data/ais/2018/ais_2018-09-26_scene.csv"
ERA5_FILE = "data/era5/era5_2018-09-26.nc"

OIL_LAT = 28.9047446258
OIL_LON = -89.0242701655
SLICK_AXIS = 233.7

# Sentinel-1 acquisition time
SAR_TIME = pd.Timestamp("2018-09-26 14:24:00", tz="UTC")


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0

    lat1 = np.radians(lat1)
    lat2 = np.radians(lat2)
    dlat = lat2 - lat1
    dlon = np.radians(lon2 - lon1)

    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(lat1)
        * np.cos(lat2)
        * np.sin(dlon / 2) ** 2
    )

    return 2 * R * np.arcsin(np.sqrt(a))


def angular_difference(a, b):
    d = abs(a - b) % 180
    return min(d, 180 - d)


def main():

    print("Loading MarineCadastre AIS...")

    ais = pd.read_csv(AIS_FILE)

    ais["base_date_time"] = pd.to_datetime(
        ais["base_date_time"],
        utc=True
    )

    # Remove invalid coordinates
    ais = ais[
        ais["latitude"].between(-90, 90)
        & ais["longitude"].between(-180, 180)
    ].copy()

    print("AIS records:", len(ais))

    # Distance of every AIS position from oil centroid
    ais["distance_km"] = haversine_km(
        ais["latitude"].values,
        ais["longitude"].values,
        OIL_LAT,
        OIL_LON
    )

    # ERA5 wind
    ds = xr.open_dataset(ERA5_FILE)

    cell = ds.sel(
        latitude=OIL_LAT,
        longitude=OIL_LON,
        method="nearest"
    )

    wind_directions = []
    wind_speeds = []

    for t in ds.valid_time.values:

        u = float(cell["u10"].sel(valid_time=t))
        v = float(cell["v10"].sel(valid_time=t))

        speed = np.sqrt(u ** 2 + v ** 2)

        direction_to = (
            np.degrees(np.arctan2(u, v)) + 360
        ) % 360

        wind_directions.append(direction_to)
        wind_speeds.append(speed)

    wind_direction = float(np.mean(wind_directions))
    wind_speed = float(np.mean(wind_speeds))

    wind_slick_diff = angular_difference(
        wind_direction,
        SLICK_AXIS
    )

    wind_score = max(
        0,
        1 - wind_slick_diff / 90
    ) * 100

    print("\nEnvironmental conditions")
    print("------------------------")
    print(f"Mean wind speed: {wind_speed:.2f} m/s")
    print(f"Mean wind direction: {wind_direction:.1f}°")
    print(f"Slick axis: {SLICK_AXIS:.1f}°")
    print(f"Wind/slick difference: {wind_slick_diff:.1f}°")
    print(f"Wind consistency: {wind_score:.1f}/100")

    results = []

    # Evaluate each vessel independently
    for mmsi, track in ais.groupby("mmsi"):

        track = track.sort_values("base_date_time").copy()

        if len(track) < 2:
            continue

        # Closest physical approach to detected oil centroid
        closest_idx = track["distance_km"].idxmin()
        closest = track.loc[closest_idx]

        closest_distance = float(closest["distance_km"])
        closest_time = closest["base_date_time"]

        time_diff_min = abs(
            (closest_time - SAR_TIME).total_seconds()
        ) / 60.0

        # AIS course at closest approach
        course = float(closest["cog"])

        if not np.isfinite(course) or course < 0 or course > 360:
            continue

        ais_slick_diff = angular_difference(
            course,
            SLICK_AXIS
        )

        ais_score = max(
            0,
            1 - ais_slick_diff / 90
        ) * 100

        # Directional consistency
        directional_score = (
            0.5 * wind_score
            + 0.5 * ais_score
        )

        # Proximity score
        # 0 km = 100
        # >=25 km = 0
        proximity_score = max(
            0,
            1 - closest_distance / 25
        ) * 100

        # Temporal score
        # 0 min = 100
        # 180 min or more = 0
        temporal_score = max(
            0,
            1 - time_diff_min / 180
        ) * 100

        # Final score
        final_score = (
            0.40 * proximity_score
            + 0.25 * temporal_score
            + 0.20 * ais_score
            + 0.15 * wind_score
        )

        results.append({
            "mmsi": mmsi,
            "vessel_name": closest["vessel_name"],
            "imo": closest["imo"],
            "vessel_type": closest["vessel_type"],
            "closest_time": closest_time,
            "distance_km": closest_distance,
            "time_difference_min": time_diff_min,
            "ais_course": course,
            "ais_slick_difference_deg": ais_slick_diff,
            "wind_slick_difference_deg": wind_slick_diff,
            "ais_direction_score": ais_score,
            "wind_score": wind_score,
            "directional_score": directional_score,
            "proximity_score": proximity_score,
            "temporal_score": temporal_score,
            "final_attribution_score": final_score
        })

    result = pd.DataFrame(results)

    result = result.sort_values(
        "final_attribution_score",
        ascending=False
    )

    output = (
        "data/ais/2018/"
        "trajectory_attribution_2018-09-26.csv"
    )

    result.to_csv(output, index=False)

    print("\n" + "=" * 75)
    print("TRAJECTORY-BASED ATTRIBUTION RANKING")
    print("=" * 75)

    display_cols = [
        "vessel_name",
        "mmsi",
        "distance_km",
        "time_difference_min",
        "ais_course",
        "ais_slick_difference_deg",
        "proximity_score",
        "temporal_score",
        "final_attribution_score"
    ]

    print(
        result[display_cols]
        .head(15)
        .to_string(index=False)
    )

    top = result.iloc[0]

    print("\n" + "=" * 75)
    print("TOP ATTRIBUTION CANDIDATE")
    print("=" * 75)

    print(f"Vessel: {top['vessel_name']}")
    print(f"MMSI: {top['mmsi']}")
    print(f"IMO: {top['imo']}")
    print(f"Closest approach: {top['distance_km']:.2f} km")
    print(f"Time difference: {top['time_difference_min']:.1f} min")
    print(f"AIS/slick angle: {top['ais_slick_difference_deg']:.1f}°")
    print(f"Final score: {top['final_attribution_score']:.1f}/100")

    if top["final_attribution_score"] >= 80:
        status = "HIGH PRIORITY"
    elif top["final_attribution_score"] >= 60:
        status = "MEDIUM PRIORITY"
    else:
        status = "LOW PRIORITY"

    print(f"Attribution status: {status}")
    print("Causality: NOT CONFIRMED")

    print("\nSaved:", output)


if __name__ == "__main__":
    main()
