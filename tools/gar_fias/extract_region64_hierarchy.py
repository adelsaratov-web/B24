#!/usr/bin/env python3
import csv
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from remotezip import RemoteZip

from extract_region64 import discover_source

OUT = Path("gar_region64")
REGION = "64"


def base(name: str) -> str:
    return name.replace("\\", "/").rsplit("/", 1)[-1].upper()


def in_region(name: str) -> bool:
    return REGION in name.replace("\\", "/").split("/")


def pick_files(infos):
    wanted = {"addr": [], "adm": [], "mun": []}
    for info in infos:
        n = info.filename
        if not in_region(n) or not n.upper().endswith(".XML"):
            continue
        b = base(n)
        if b.startswith("AS_ADDR_OBJ_") and not b.startswith("AS_ADDR_OBJ_PARAMS_"):
            wanted["addr"].append(info)
        elif b.startswith("AS_ADM_HIERARCHY_"):
            wanted["adm"].append(info)
        elif b.startswith("AS_MUN_HIERARCHY_"):
            wanted["mun"].append(info)
    return wanted


def parse_addr(rz, infos):
    out = OUT / "gar_region64_addr_objects_active.csv"
    fields = ["source", "objectid", "objectguid", "name", "typename", "level", "isactual", "isactive", "startdate", "enddate"]
    count = 0
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for info in infos:
            print(f"addr {info.filename} compressed={info.compress_size}")
            with rz.open(info.filename) as xf:
                for _, elem in ET.iterparse(xf, events=("end",)):
                    tag = elem.tag.rsplit("}", 1)[-1]
                    if tag == "OBJECT":
                        a = elem.attrib
                        if a.get("ISACTUAL") == "1" and a.get("ISACTIVE") == "1":
                            w.writerow({
                                "source": info.filename,
                                "objectid": a.get("OBJECTID", ""),
                                "objectguid": a.get("OBJECTGUID", ""),
                                "name": a.get("NAME", ""),
                                "typename": a.get("TYPENAME", ""),
                                "level": a.get("LEVEL", ""),
                                "isactual": a.get("ISACTUAL", ""),
                                "isactive": a.get("ISACTIVE", ""),
                                "startdate": a.get("STARTDATE", ""),
                                "enddate": a.get("ENDDATE", ""),
                            })
                            count += 1
                        elem.clear()
    return out, count


def parse_hierarchy(rz, infos, label):
    out = OUT / f"gar_region64_{label}_hierarchy_active.csv"
    fields = ["source", "objectid", "parentobjid", "path", "isactive", "startdate", "enddate"]
    count = 0
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for info in infos:
            print(f"{label} {info.filename} compressed={info.compress_size}")
            with rz.open(info.filename) as xf:
                for _, elem in ET.iterparse(xf, events=("end",)):
                    tag = elem.tag.rsplit("}", 1)[-1]
                    if tag == "ITEM":
                        a = elem.attrib
                        if a.get("ISACTIVE") == "1":
                            w.writerow({
                                "source": info.filename,
                                "objectid": a.get("OBJECTID", ""),
                                "parentobjid": a.get("PARENTOBJID", ""),
                                "path": a.get("PATH", ""),
                                "isactive": a.get("ISACTIVE", ""),
                                "startdate": a.get("STARTDATE", ""),
                                "enddate": a.get("ENDDATE", ""),
                            })
                            count += 1
                        elem.clear()
    return out, count


def main():
    OUT.mkdir(exist_ok=True)
    meta, url, attempts = discover_source()
    with RemoteZip(url, timeout=180) as rz:
        selected = pick_files(rz.infolist())
        if not selected["addr"] or not selected["adm"]:
            raise SystemExit({k: [i.filename for i in v] for k, v in selected.items()})
        addr_file, addr_count = parse_addr(rz, selected["addr"])
        adm_file, adm_count = parse_hierarchy(rz, selected["adm"], "adm")
        mun_count = 0
        mun_file = None
        if selected["mun"]:
            mun_file, mun_count = parse_hierarchy(rz, selected["mun"], "mun")

    manifest = {
        "selectedURL": url,
        "datasetDateKey": meta.get("datasetDateKey") or meta.get("VersionId") or meta.get("versionId"),
        "files": {k: [i.filename for i in v] for k, v in selected.items()},
        "counts": {"addr_active": addr_count, "adm_active": adm_count, "mun_active": mun_count},
        "outputs": {"addr": str(addr_file), "adm": str(adm_file), "mun": str(mun_file) if mun_file else None},
    }
    (OUT / "hierarchy_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
