#!/usr/bin/env python3
import csv
import io
import json
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from remotezip import RemoteZip

META_URL = "https://fias.nalog.ru/WebServices/Public/GetLastDownloadFileInfo"
REGION = "64"
OUT = Path("gar_region64")
TARGET_MARKERS = ("AS_HOUSES_", "AS_APARTMENTS_")


def lname(name: str) -> str:
    return name.rsplit("/", 1)[-1].upper()


def wanted(name: str) -> bool:
    parts = name.replace("\\", "/").split("/")
    if REGION not in parts:
        return False
    base = lname(name)
    return base.endswith(".XML") and any(m in base for m in TARGET_MARKERS)


def stream_rows(data: bytes, source_name: str, writer):
    for event, elem in ET.iterparse(io.BytesIO(data), events=("end",)):
        tag = elem.tag.rsplit("}", 1)[-1]
        if tag in {"HOUSE", "APARTMENT"}:
            a = elem.attrib
            writer.writerow({
                "source": source_name,
                "kind": tag,
                "objectid": a.get("OBJECTID", ""),
                "objectguid": a.get("OBJECTGUID", ""),
                "changeid": a.get("CHANGEID", ""),
                "objecttype": a.get("HOUSETYPE", a.get("APARTTYPE", "")),
                "number": a.get("HOUSENUM", a.get("NUMBER", "")),
                "addnum1": a.get("ADDNUM1", ""),
                "addnum2": a.get("ADDNUM2", ""),
                "startdate": a.get("STARTDATE", ""),
                "enddate": a.get("ENDDATE", ""),
                "isactual": a.get("ISACTUAL", ""),
                "isactive": a.get("ISACTIVE", ""),
                "previd": a.get("PREVID", ""),
                "nextid": a.get("NEXTID", ""),
            })
            elem.clear()


def main():
    OUT.mkdir(exist_ok=True)
    r = requests.get(META_URL, timeout=60)
    r.raise_for_status()
    meta = r.json()
    (OUT / "fias_last_download_info.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    url = meta.get("GarXMLFullURL") or meta.get("garXMLFullUrl")
    if not url:
        raise SystemExit("GarXMLFullURL not found in FIAS metadata")

    fields = [
        "source", "kind", "objectid", "objectguid", "changeid", "objecttype",
        "number", "addnum1", "addnum2", "startdate", "enddate", "isactual",
        "isactive", "previd", "nextid"
    ]
    out_csv = OUT / "gar_region64_houses_apartments.csv"
    manifest = []

    with RemoteZip(url, timeout=120) as rz, out_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        names = [i.filename for i in rz.infolist() if wanted(i.filename)]
        if not names:
            sample = [i.filename for i in rz.infolist() if REGION in i.filename.replace("\\", "/").split("/")][:100]
            (OUT / "region64_sample_names.txt").write_text("\n".join(sample), encoding="utf-8")
            raise SystemExit("No AS_HOUSES/AS_APARTMENTS XML found for region 64")
        for name in names:
            info = rz.getinfo(name)
            print(f"extracting {name} compressed={info.compress_size} bytes")
            data = rz.read(name)
            manifest.append({"name": name, "size": info.file_size, "compressed": info.compress_size})
            stream_rows(data, name, writer)

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"version": meta.get("VersionId") or meta.get("versionId"), "url": url, "files": len(manifest), "output": str(out_csv)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
