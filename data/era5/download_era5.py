import os
import cdsapi

client = cdsapi.Client(
    url="https://cds.climate.copernicus.eu/api",
    key=os.environ["ERA5_CDS_API_KEY"],
)

client.retrieve(
    "reanalysis-era5-single-levels",
    {
        "product_type": "reanalysis",
        "variable": [
            "10m_u_component_of_wind",
            "10m_v_component_of_wind",
        ],
        "year": "2018",
        "month": "09",
        "day": "26",
        "time": [
            "14:00",
            "15:00",
        ],
        "area": [
            29.10,
            -89.50,
            28.70,
            -88.80,
        ],
        "data_format": "netcdf",
    },
    "data/era5/era5_2018-09-26.nc",
)

print("ERA5 WIND DOWNLOAD COMPLETE")
