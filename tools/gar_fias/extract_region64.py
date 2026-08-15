#!/usr/bin/env python3
import csv
import html
import io
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from remotezip import RemoteZip

META_URL = "https://fias.nalog.ru/WebServices/Public/GetLastDownloadFileInfo"
OPEN_DATA_PAGE = "https://www.nalog.gov.ru/opendata/7707329152-fias/"
REGION = "64"
OUT = Path("gar_region64")
TARGET_MARKERS = ("AS_HOUSES_", "AS_APARTMENTS_")
UA = "transgaz64-gar-readonly/1.1"


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


def req_get(url, **kwargs):
    headers = dict(kwargs.pop("headers", {}) or {})
    headers.setdefault("User-Agent", UA)
    return requests.get(url, headers=headers, **kwargs)


def extract_open_data_links(page_text: str):
    text = html.unescape(page_text)
    raw = re.findall(r'https?://[^"\'<>\s]+data-[0-9-]+-structure-20191024\.zip', text, flags=re.I)
    raw += re.findall(r'href=["\']([^"\']*data-[0-9-]+-structure-20191024\.zip)["\']', text, flags=re.I)
    links = []
    for x in raw:
        u = urllib.parse.urljoin(OPEN_DATA_PAGE, x)
        if u not in links:
            links.append(u)
    return links


def date_key(url: str):
    m = re.search(r'data-(\d{8})-structure-20191024\.zip', url, flags=re.I)
    if not m:
        return "00000000"
    d = m.group(1)
    # FIAS filenames use DDMMYYYY; sort as YYYYMMDD.
    return d[4:8] + d[2:4] + d[0:2]


def mirror_candidates(url: str):
    p = urllib.parse.urlsplit(url)
    hosts = [p.netloc, "data.nalog.ru", "file.nalog.ru", "fias-file.nalog.ru", "fias.nalog.ru"]
    out = []
    for host in hosts:
        if not host:
            continue
        u = urllib.parse.urlunsplit((p.scheme or "https", host, p.path, p.query, p.fragment))
        if u not in out:
            out.append(u)
    return out


def probe_range(url: str):
    try:
        r = req_get(url, headers={"Range": "bytes=0-0"}, stream=True, timeout=(12, 20), allow_redirects=True)
        status = r.status_code
        ar = (r.headers.get("Accept-Ranges") or "").lower()
        cr = r.headers.get("Content-Range") or ""
        cl = r.headers.get("Content-Length") or ""
        final = r.url
        r.close()
        ok = status == 206 or (status == 200 and "bytes" in ar)
        return {"ok": ok, "status": status, "accept_ranges": ar, "content_range": cr, "content_length": cl, "final_url": final}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def discover_source():
    attempts = []
    # Preferred current metadata endpoint.
    try:
        r = req_get(META_URL, timeout=(10, 20))
        attempts.append({"kind": "metadata", "url": META_URL, "status": r.status_code})
        r.raise_for_status()
        meta = r.json()
        url = meta.get("GarXMLFullURL") or meta.get("garXMLFullUrl")
        if url:
            for candidate in mirror_candidates(url):
                pr = probe_range(candidate)
                attempts.append({"kind": "metadata_candidate", "url": candidate, **pr})
                if pr.get("ok"):
                    return meta, pr.get("final_url") or candidate, attempts
    except Exception as e:
        attempts.append({"kind": "metadata", "url": META_URL, "error": f"{type(e).__name__}: {e}"})

    # Fallback: official FNS open-data catalogue page, no search-engine cache.
    r = req_get(OPEN_DATA_PAGE, timeout=(12, 30))
    attempts.append({"kind": "open_data_page", "url": OPEN_DATA_PAGE, "status": r.status_code})
    r.raise_for_status()
    links = sorted(extract_open_data_links(r.text), key=date_key, reverse=True)
    if not links:
        raise RuntimeError("Official FNS open-data page did not expose a FIAS XML dataset link")
    for link in links[:8]:
        for candidate in mirror_candidates(link):
            pr = probe_range(candidate)
            attempts.append({"kind": "open_data_candidate", "catalog_url": link, "url": candidate, **pr})
            if pr.get("ok"):
                meta = {
                    "source": "FNS_OPEN_DATA_PAGE",
                    "catalogPage": OPEN_DATA_PAGE,
                    "catalogURL": link,
                    "selectedURL": pr.get("final_url") or candidate,
                    "datasetDateKey": date_key(link),
                }
                return meta, pr.get("final_url") or candidate, attempts
    raise RuntimeError("No official FNS FIAS dataset candidate with HTTP Range support was reachable")


def main():
    OUT.mkdir(exist_ok=True)
    meta, url, attempts = discover_source()
    meta = dict(meta)
    meta["selectedURL"] = url
    meta["networkAttempts"] = attempts
    (OUT / "fias_last_download_info.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

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
        infos = rz.infolist()
        names = [i.filename for i in infos if wanted(i.filename)]
        if not names:
            sample = [i.filename for i in infos if REGION in i.filename.replace("\\", "/").split("/")][:100]
            (OUT / "region64_sample_names.txt").write_text("\n".join(sample), encoding="utf-8")
            raise SystemExit("No AS_HOUSES/AS_APARTMENTS XML found for region 64")
        for name in names:
            info = rz.getinfo(name)
            print(f"extracting {name} compressed={info.compress_size} bytes")
            data = rz.read(name)
            manifest.append({"name": name, "size": info.file_size, "compressed": info.compress_size})
            stream_rows(data, name, writer)

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"version": meta.get("VersionId") or meta.get("versionId") or meta.get("datasetDateKey"), "url": url, "files": len(manifest), "output": str(out_csv)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
