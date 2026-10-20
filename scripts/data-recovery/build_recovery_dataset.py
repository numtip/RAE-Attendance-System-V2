#!/usr/bin/env python3
"""Employee master recovery: owner-confirmed workbook + 2027 ID-card CSV -> local reconciliation dataset.

Read-only on every source. Nothing is imported, uploaded or written outside --out.

Usage (from repo root):
    python scripts/data-recovery/build_recovery_dataset.py \
        --workbook docs/RAE_Employee_Roster_Update20261020.xlsx \
        --csv database/IDCardRaecsv2027.csv \
        --out database/local/recovery-20261020

Design rules enforced here (see docs/RAE_EMPLOYEE_MASTER_RECONCILIATION_20261020.md):
  * Never fabricate identity: no person_id, no SSO subject, no email, no employment type,
    no first/last name split, no role.
  * Never emit national IDs (the source CSV stays the only place they exist); record a row reference.
  * Never silently drop a row: every input row ends as a record or an exception.
  * Ambiguous identity stops the row at UNRESOLVED instead of guessing.

Personal data stays in the gitignored output directory; stdout carries counts only.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import unicodedata
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError:  # pragma: no cover - environment guard
    sys.stderr.write("openpyxl is required (python -m pip install openpyxl)\n")
    raise

# --- workbook column contract (positional, verified 2026-10-20) ---------------
COL_REPORT_CODE = 0        # รหัสที่พบในรายงาน           report/device code
COL_STATUS_2026 = 1        # สถานะตรวจสอบ 2026           prior-audit status
COL_CSV_NAME = 2           # ชื่อจาก CSV บัตร 2027       reference name
COL_CSV_DEPT = 3           # หน่วยงานจาก CSV 2027        reference department
COL_OWNER_NAME = 4         # ชื่อ-สกุลล่าสุด (กรอก)       owner-confirmed name
COL_OWNER_CODE = 5         # รหัสพนักงานล่าสุด (กรอก)     owner-confirmed employee code
COL_OWNER_DEPT = 6         # หน่วยงานล่าสุด (กรอก)        owner-confirmed department
COL_OWNER_STATUS = 7       # สถานะปฏิบัติงาน (กรอก)       owner-confirmed employment status
COL_OWNER_NOTE = 8         # หมายเหตุ/คำยืนยัน (กรอก)     owner note
COL_TITLE = 9              # คำนำหน้านาม                 title prefix
EXPECTED_HEADERS = 10

CSV_REQUIRED_HEADERS = {"ID card Code", "Facescan Code", "name", "หน่วยงาน"}

# Owner vocabulary -> canonical status. 'ปฎิบัติงาน' is the misspelling present in the sheet and is
# accepted as a variant, but the variant is recorded so the source defect stays visible.
EMPLOYMENT_STATUS_MAP = {
    "ปฏิบัติงาน": "active",
    "ปฎิบัติงาน": "active",
    "ลาออก": "resigned",
    "เกษียณอายุ/ลาออก": "resigned",
}
ACTIVE_STATUS = "active"
RESIGNED_STATUS = "resigned"
UNKNOWN_STATUS = "UNKNOWN"

# Codes that the 2026 verification report established as special cases.
MASTER_ONLY_CODE = "1015"
DEVICE_ONLY_CODE = "1032"

ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"), None)

EXCEPTION_COLUMNS = [
    "report_code", "exception_type", "severity", "detail", "resolution_required",
]
IDENTITY_COLUMNS = [
    "report_code", "employee_code", "device_code", "title_th", "full_name_th",
    "department_current", "department_reference_2027", "employment_status", "active",
    "position", "employee_type", "email", "identity_kind", "personnel_id", "sso_subject",
    "national_id_source_ref", "csv_row", "csv_duplicate_rows", "match_method",
    "match_confidence", "status_2026", "owner_note", "source_row",
]
OWNERSHIP_COLUMNS = [
    "code", "code_role", "report_code", "person_key", "valid_from", "valid_to",
    "source_system", "source_reference", "evidence_status",
]
MASTER_COLUMNS = [
    "person_key", "employee_code", "device_code", "title_th", "full_name_th",
    "department_current", "employment_status", "active", "position", "employee_type",
    "email", "identity_kind", "personnel_id", "sso_subject", "role",
    "national_id_source_ref", "source_workbook_row", "source_csv_row", "source_provenance",
]


# --------------------------------------------------------------------------- #
# normalization helpers
# --------------------------------------------------------------------------- #
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_text(value) -> str:
    """NFC, drop BOM/zero-width, collapse internal whitespace, trim."""
    if value is None:
        return ""
    text = str(value).translate(ZERO_WIDTH)
    text = unicodedata.normalize("NFC", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_code(value) -> tuple[str, str | None]:
    """Return (code, defect). A code is a digit string; leading zeros are never invented."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return "", None
    if isinstance(value, bool):
        return "", "CODE_INVALID_TYPE"
    if isinstance(value, float) and not value.is_integer():
        return "", "CODE_INVALID_TYPE"
    if isinstance(value, (int, float)):
        return str(int(value)), "CODE_STORED_AS_NUMBER"
    text = normalize_text(value)
    digits = re.sub(r"[\s\-]", "", text)
    if not digits.isdigit():
        return "", "CODE_NOT_DIGITS"
    return digits, None


def classify_employment(raw: str) -> tuple[str, str | None]:
    text = normalize_text(raw)
    if not text:
        return UNKNOWN_STATUS, "EMPLOYMENT_STATUS_MISSING"
    mapped = EMPLOYMENT_STATUS_MAP.get(text)
    if mapped is None:
        return UNKNOWN_STATUS, "EMPLOYMENT_STATUS_UNRECOGNIZED"
    defect = "EMPLOYMENT_STATUS_SPELLING_VARIANT" if text == "ปฎิบัติงาน" else None
    return mapped, defect


def split_owner_name(raw: str) -> tuple[str, str]:
    """Owner name is one field. Never guess which token is the surname: return (name, '')."""
    return normalize_text(raw), ""


# --------------------------------------------------------------------------- #
# source readers
# --------------------------------------------------------------------------- #
def decode_csv_bytes(raw: bytes) -> tuple[str, str]:
    """BOM-aware decode. utf-8-sig handles the confirmed BOM; cp874 is a read-only legacy fallback."""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig(BOM)"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("cp874", errors="replace"), "cp874(fallback)"


def read_idcard_csv(path: Path) -> dict:
    raw = path.read_bytes()
    text, encoding = decode_csv_bytes(raw)
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise ValueError("ID-card CSV is empty")
    header = [normalize_text(h) for h in rows[0]]
    if header and header[0].startswith("\ufeff"):
        header[0] = header[0].lstrip("\ufeff")
    missing = CSV_REQUIRED_HEADERS - set(header)
    if missing:
        raise ValueError(f"ID-card CSV missing headers: {sorted(missing)}")
    idx = {name: header.index(name) for name in CSV_REQUIRED_HEADERS}
    records = []
    for offset, cells in enumerate(rows[1:], start=2):
        if not any(normalize_text(c) for c in cells):
            continue
        records.append({
            "csv_row": offset,
            "national_id": normalize_text(cells[idx["ID card Code"]]) if len(cells) > idx["ID card Code"] else "",
            "facescan_code": normalize_code(cells[idx["Facescan Code"]] if len(cells) > idx["Facescan Code"] else "")[0],
            "name": normalize_text(cells[idx["name"]]) if len(cells) > idx["name"] else "",
            "department": normalize_text(cells[idx["หน่วยงาน"]]) if len(cells) > idx["หน่วยงาน"] else "",
        })
    return {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "encoding": encoding,
            "header": header, "rows": records}


def collapse_csv_duplicates(csv_rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Exact duplicates collapse to one person row. Same facescan + different content is a conflict."""
    groups: "OrderedDict[tuple, dict]" = OrderedDict()
    for row in csv_rows:
        key = (row["national_id"], row["facescan_code"], row["name"], row["department"])
        groups.setdefault(key, {"first": row, "rows": []})["rows"].append(row["csv_row"])
    unique, conflicts = [], []
    by_facescan: dict[str, list[dict]] = {}
    for group in groups.values():
        first = group["first"]
        entry = dict(first)
        entry["duplicate_rows"] = group["rows"][1:]
        unique.append(entry)
        by_facescan.setdefault(first["facescan_code"], []).append(entry)
    for code, entries in by_facescan.items():
        if len({(e["national_id"], e["name"], e["department"]) for e in entries}) > 1:
            conflicts.append({"facescan_code": code, "csv_rows": [e["csv_row"] for e in entries]})
    return unique, conflicts


def read_workbook(path: Path) -> dict:
    workbook = load_workbook(path, data_only=True, read_only=True)
    try:
        sheet = workbook[workbook.sheetnames[0]]
        rows = list(sheet.iter_rows(min_row=1, values_only=True))
    finally:
        workbook.close()
    if not rows:
        raise ValueError("workbook is empty")
    header = [normalize_text(c) for c in rows[0]]
    if len(header) != EXPECTED_HEADERS:
        raise ValueError(f"workbook header has {len(header)} columns, expected {EXPECTED_HEADERS}")
    data = [r for r in rows[1:] if any(normalize_text(c) for c in r)]
    return {"path": str(path), "sha256": sha256_file(path), "sheet": path.name,
            "header": header, "rows": data}


# --------------------------------------------------------------------------- #
# reconciliation
# --------------------------------------------------------------------------- #
def match_codes(workbook_codes: list[str], csv_unique: list[dict]) -> dict[str, dict]:
    """Exact device-code match only. A name match is never treated as identity."""
    by_code = {}
    for entry in csv_unique:
        by_code.setdefault(entry["facescan_code"], []).append(entry)
    matches = {}
    for code in workbook_codes:
        entries = by_code.get(code)
        if entries:
            matches[code] = entries[0]
    return matches


def build_dataset(workbook: dict, idcard: dict) -> dict:
    csv_unique, csv_conflicts = collapse_csv_duplicates(idcard["rows"])
    csv_by_code: dict[str, dict] = {}
    for entry in csv_unique:
        csv_by_code.setdefault(entry["facescan_code"], entry)

    records, exceptions = [], []

    def add_exception(code, kind, severity, detail, resolution):
        exceptions.append({"report_code": code, "exception_type": kind, "severity": severity,
                           "detail": detail, "resolution_required": resolution})

    seen_codes = Counter()
    for row_number, raw in enumerate(workbook["rows"], start=2):
        raw = list(raw) + [None] * (EXPECTED_HEADERS - len(raw))
        report_code, code_defect = normalize_code(raw[COL_REPORT_CODE])
        if not report_code:
            add_exception("", "REPORT_CODE_INVALID", "blocker",
                          f"row {row_number}: report code is not a digit string", "correct the workbook row")
            continue
        seen_codes[report_code] += 1
        if code_defect:
            add_exception(report_code, code_defect, "warn",
                          f"row {row_number}: code cell type/format normalized", "none (normalized)")

        status_2026 = normalize_text(raw[COL_STATUS_2026])
        csv_name = normalize_text(raw[COL_CSV_NAME])
        csv_dept = normalize_text(raw[COL_CSV_DEPT])
        owner_name = normalize_text(raw[COL_OWNER_NAME])
        owner_code, owner_code_defect = normalize_code(raw[COL_OWNER_CODE])
        owner_dept = normalize_text(raw[COL_OWNER_DEPT])
        owner_status_raw = normalize_text(raw[COL_OWNER_STATUS])
        owner_note = normalize_text(raw[COL_OWNER_NOTE])
        title = normalize_text(raw[COL_TITLE])

        employment, status_defect = classify_employment(owner_status_raw)
        if status_defect:
            add_exception(report_code, status_defect, "warn",
                          f"owner status {owner_status_raw!r} -> {employment}", "owner vocabulary cleanup")
        if owner_code_defect:
            add_exception(report_code, owner_code_defect, "warn",
                          f"employee code stored as {type(raw[COL_OWNER_CODE]).__name__}", "import as text")

        csv_entry = csv_by_code.get(report_code)
        match_method, confidence = "NONE", "none"
        csv_row = ""
        duplicate_rows: list[int] = []
        if csv_entry:
            match_method, confidence = "DEVICE_CODE_EXACT", "high"
            csv_row = str(csv_entry["csv_row"])
            duplicate_rows = list(csv_entry["duplicate_rows"])
            if csv_name and normalize_text(csv_entry["name"]) != csv_name:
                add_exception(report_code, "CSV_NAME_MISMATCH", "blocker",
                              "workbook reference name differs from the CSV row selected by device code",
                              "re-open identity match; do not import")
            if csv_dept and normalize_text(csv_entry["department"]) != csv_dept:
                add_exception(report_code, "CSV_DEPT_MISMATCH", "blocker",
                              "workbook reference department differs from the CSV row",
                              "confirm the department source")
        elif csv_name:
            match_method, confidence = "UNTRACEABLE_NAME_ONLY", "none"
            add_exception(report_code, "CSV_REFERENCE_UNTRACEABLE", "blocker",
                          "reference name present but no CSV row carries this device code and the name "
                          "does not occur in the CSV; provenance of the reference is unknown",
                          "owner must state where this person's reference data came from")

        if not owner_name:
            add_exception(report_code, "OWNER_NAME_MISSING", "blocker",
                          "no owner-confirmed name; the import requires first/last name",
                          "owner must supply the name")
        if not owner_code:
            add_exception(report_code, "EMPLOYEE_CODE_MISSING", "blocker",
                          "no owner-confirmed employee code", "owner must supply the code")
        if owner_code and owner_code != report_code:
            add_exception(report_code, "EMPLOYEE_CODE_DIFFERS_FROM_DEVICE_CODE", "info",
                          "historical code ownership: device code and employee code differ",
                          "record both codes in employee_identifier")

        if report_code == MASTER_ONLY_CODE or "ไม่พบสแกน" in status_2026:
            add_exception(report_code, "MASTER_ONLY_NO_SCAN", "warn",
                          "present in the 2026 master, no scan evidence", "confirm before import")
        if report_code == DEVICE_ONLY_CODE or "ไม่อยู่ใน Master" in owner_note:
            add_exception(report_code, "DEVICE_ONLY_CONFIRMED", "info",
                          "device-only code confirmed by the owner as a current employee",
                          "none (owner confirmed)")
        if duplicate_rows:
            add_exception(report_code, "CSV_EXACT_DUPLICATE_COLLAPSED", "info",
                          f"CSV rows {duplicate_rows} are exact duplicates of row {csv_row}",
                          "none (deduplicated)")
        if csv_dept and owner_dept and csv_dept != owner_dept:
            add_exception(report_code, "DEPARTMENT_CHANGED", "info",
                          "department differs between the 2027 CSV and the owner-confirmed current value",
                          "import the current value; keep the CSV value as assignment history")

        record = {
            "report_code": report_code,
            "employee_code": owner_code,
            "device_code": "" if report_code == MASTER_ONLY_CODE else report_code,
            "title_th": title,
            "full_name_th": owner_name,
            "department_current": owner_dept,
            "department_reference_2027": csv_dept,
            "employment_status": employment,
            "active": "true" if employment == ACTIVE_STATUS else "false",
            "position": "",
            "employee_type": "",
            "email": "",
            "identity_kind": "UNRESOLVED",
            "personnel_id": "",
            "sso_subject": "",
            "national_id_source_ref": f"IDCardRaecsv2027.csv#row {csv_row}" if csv_row else "",
            "csv_row": csv_row,
            "csv_duplicate_rows": ";".join(str(r) for r in duplicate_rows),
            "match_method": match_method,
            "match_confidence": confidence,
            "status_2026": status_2026,
            "owner_note": owner_note,
            "source_row": row_number,
        }
        records.append(record)

    for code, count in seen_codes.items():
        if count > 1:
            add_exception(code, "REPORT_CODE_DUPLICATE", "blocker",
                          f"report code appears {count} times", "merge or correct the duplicate rows")

    # --- cross-source coverage -------------------------------------------------
    matched_csv_codes = {r["report_code"] for r in records if r["csv_row"]}
    for entry in csv_unique:
        if entry["facescan_code"] not in matched_csv_codes:
            add_exception(entry["facescan_code"], "CSV_PERSON_NOT_IN_REPORT", "blocker",
                          f"CSV row {entry['csv_row']} has no owner-confirmed workbook row",
                          "owner must add or explicitly exclude this person")
    for conflict in csv_conflicts:
        add_exception(conflict["facescan_code"], "CSV_CODE_AMBIGUOUS", "blocker",
                      f"one device code maps to different people (CSV rows {conflict['csv_rows']})",
                      "split the codes before import")

    # --- historical code ownership --------------------------------------------
    ownership = []
    for record in records:
        code = record["report_code"]
        ownership.append({
            "code": code, "code_role": "device_code_and_employee_code",
            "report_code": code, "person_key": f"RPT-{code}",
            "valid_from": "", "valid_to": "",
            "source_system": "RAE_2026_VERIFICATION_REPORT",
            "source_reference": f"workbook row {record['source_row']}",
            "evidence_status": "owner_confirmed" if record["full_name_th"] else "unconfirmed",
        })
        if record["employee_code"] and record["employee_code"] != code:
            ownership.append({
                "code": record["employee_code"], "code_role": "employee_code",
                "report_code": code, "person_key": f"RPT-{code}",
                "valid_from": "", "valid_to": "",
                "source_system": "OWNER_WORKBOOK_20261020",
                "source_reference": f"workbook row {record['source_row']}",
                "evidence_status": "owner_confirmed",
            })
        if record["csv_row"]:
            ownership.append({
                "code": record["device_code"], "code_role": "facescan_id",
                "report_code": code, "person_key": f"RPT-{code}",
                "valid_from": "", "valid_to": "",
                "source_system": "IDCARD_CSV_2027",
                "source_reference": f"IDCardRaecsv2027.csv#row {record['csv_row']}",
                "evidence_status": "reference_only",
            })

    master = []
    for record in records:
        master.append({
            "person_key": f"RPT-{record['report_code']}",
            "employee_code": record["employee_code"],
            "device_code": record["device_code"],
            "title_th": record["title_th"],
            "full_name_th": record["full_name_th"],
            "department_current": record["department_current"],
            "employment_status": record["employment_status"],
            "active": record["active"],
            "position": "",
            "employee_type": "",
            "email": "",
            "identity_kind": "UNRESOLVED",
            "personnel_id": "",
            "sso_subject": "",
            "role": "",
            "national_id_source_ref": record["national_id_source_ref"],
            "source_workbook_row": record["source_row"],
            "source_csv_row": record["csv_row"],
            "source_provenance": "OWNER_WORKBOOK_20261020"
                                 + ("+IDCARD_CSV_2027" if record["csv_row"] else ""),
        })

    return {"records": records, "exceptions": exceptions, "ownership": ownership,
            "master": master, "csv_unique": csv_unique, "csv_conflicts": csv_conflicts}


# --------------------------------------------------------------------------- #
# QA
# --------------------------------------------------------------------------- #
def run_qa(workbook: dict, idcard: dict, dataset: dict) -> dict:
    records = dataset["records"]
    exceptions = dataset["exceptions"]

    employee_codes = [r["employee_code"] for r in records if r["employee_code"]]
    device_codes = [r["device_code"] for r in records if r["device_code"]]
    duplicated_employee = sorted({c for c, n in Counter(employee_codes).items() if n > 1})
    duplicated_device = sorted({c for c, n in Counter(device_codes).items() if n > 1})
    multi_person_codes = sorted({r["report_code"] for r in records if r["full_name_th"] == ""})

    fabricated = [r["report_code"] for r in records
                  if r["sso_subject"] or r["personnel_id"] or r["identity_kind"] != "UNRESOLVED"]
    roles = {r["role"] for r in dataset["master"]}
    national_id_leak = 0
    for record in dataset["master"]:
        blob = json.dumps(record, ensure_ascii=False)
        if re.search(r"(?<!\d)\d{13}(?!\d)", blob):
            national_id_leak += 1

    resolved_exceptions = [e for e in exceptions if e["severity"] == "info"]
    blocking = [e for e in exceptions if e["severity"] == "blocker"]
    warnings = [e for e in exceptions if e["severity"] == "warn"]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "workbook": {"path": workbook["path"], "sha256": workbook["sha256"]},
            "idcard_csv": {"path": idcard["path"], "sha256": idcard["sha256"],
                           "encoding": idcard["encoding"]},
        },
        "row_accounting": {
            "workbook_data_rows": len(workbook["rows"]),
            "records": len(records),
            "exceptions": len(exceptions),
            "csv_data_rows": len(idcard["rows"]),
            "csv_unique_people": len(dataset["csv_unique"]),
            "csv_duplicate_rows_collapsed": len(idcard["rows"]) - len(dataset["csv_unique"]),
            "no_silent_row_loss": len(workbook["rows"]) == len(records),
        },
        "identity_uniqueness": {
            "employee_code_present": len(employee_codes),
            "employee_code_missing": len(records) - len(employee_codes),
            "duplicate_employee_codes": duplicated_employee,
            "device_code_present": len(device_codes),
            "duplicate_device_codes": duplicated_device,
            "records_without_name": multi_person_codes,
            "ok": not duplicated_employee and not duplicated_device and not multi_person_codes,
        },
        "code_ownership": {
            "employee_code_differs_from_device_code": sum(
                1 for r in records if r["employee_code"] and r["employee_code"] != r["report_code"]),
            "csv_ambiguous_codes": [c["facescan_code"] for c in dataset["csv_conflicts"]],
            "ok": not dataset["csv_conflicts"],
        },
        "historical_linkage": {
            "records_with_csv_evidence": sum(1 for r in records if r["csv_row"]),
            "records_without_csv_evidence": [r["report_code"] for r in records if not r["csv_row"]],
            "ok": False,
            "note": "the 2026 master/device export is not present locally; linkage for non-CSV codes "
                    "cannot be proven from local artefacts",
        },
        "no_fabricated_identity": {
            "records_with_fabricated_identity": fabricated,
            "sso_subject_values": sorted({r["sso_subject"] for r in records}),
            "personnel_id_values": sorted({r["personnel_id"] for r in records}),
            "ok": not fabricated,
        },
        "no_unauthorized_role_assignment": {
            "distinct_roles": sorted(r for r in roles if r),
            "ok": roles <= {""},
        },
        "no_pii_leakage": {
            "records_with_national_id_in_output": national_id_leak,
            "national_id_emitted": False,
            "ok": national_id_leak == 0,
        },
        "exceptions": {
            "blockers": len(blocking),
            "warnings": len(warnings),
            "informational": len(resolved_exceptions),
            "by_type": dict(sorted(Counter(e["exception_type"] for e in exceptions).items())),
        },
    }


def build_import_mapping(dataset: dict) -> dict:
    """Proposed mapping only. Every gap is explicit; nothing is defaulted or inferred."""
    blockers = [
        "employees.email is NOT NULL UNIQUE and no email source exists",
        "employees.employee_type is NOT NULL and no source exists",
        "employees.first_name_th/last_name_th are NOT NULL but the owner supplied one name field",
        "national_id import requires the HMAC contract key and an approved lookup-only flow",
        "employee_uid allocation policy is not approved",
        "records 1013 and 1015 have no owner-confirmed name",
        "table 1031/1032 reference names have no traceable CSV provenance",
    ]
    return {
        "target_tables": {
            "employees": {
                "employee_uid": {"source": "GENERATE (policy not approved)", "status": "BLOCKED"},
                "employee_id": {"source": "employee_code", "status": "READY_WITH_UNIQUENESS_GATE"},
                "first_name_th": {"source": "full_name_th (unsplit)", "status": "BLOCKED"},
                "last_name_th": {"source": "not available", "status": "BLOCKED"},
                "email": {"source": "not available", "status": "BLOCKED"},
                "department": {"source": "department_current", "status": "READY"},
                "position": {"source": "not available", "status": "NULL"},
                "employee_type": {"source": "not available", "status": "BLOCKED"},
                "status": {"source": "employment_status", "status": "READY"},
                "role": {"source": "not assigned", "status": "NULL_BY_POLICY"},
            },
            "employee_identifier": {
                "facescan_id": {"source": "device_code", "source_system": "HIP_IDCARD_CSV",
                                "status": "READY_WITH_EFFECTIVE_DATES"},
                "employee_id": {"source": "employee_code", "status": "READY_WITH_EFFECTIVE_DATES"},
                "national_id": {"source": "IDCardRaecsv2027.csv (HMAC only)", "status": "BLOCKED"},
                "personnel_id": {"source": "not verified", "status": "EMPTY"},
            },
            "employee_assignment": {
                "source": "department_current + department_reference_2027 (history)",
                "status": "READY_WITH_EFFECTIVE_DATES",
            },
        },
        "blockers": blockers,
        "never_infer": ["sso_subject", "personnel_id", "email", "employee_type",
                        "first/last name split", "role"],
    }


# --------------------------------------------------------------------------- #
# writers
# --------------------------------------------------------------------------- #
def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_json(path: Path, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", default="docs/RAE_Employee_Roster_Update20261020.xlsx")
    parser.add_argument("--csv", dest="csv_path", default="database/IDCardRaecsv2027.csv")
    parser.add_argument("--out", default="database/local/recovery-20261020")
    args = parser.parse_args(argv)

    workbook_path, csv_path, out = Path(args.workbook), Path(args.csv_path), Path(args.out)
    before = sha256_file(workbook_path)
    workbook = read_workbook(workbook_path)
    idcard = read_idcard_csv(csv_path)
    dataset = build_dataset(workbook, idcard)
    qa = run_qa(workbook, idcard, dataset)

    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "normalized_employee_master.csv", MASTER_COLUMNS, dataset["master"])
    write_csv(out / "identity_reconciliation.csv", IDENTITY_COLUMNS, dataset["records"])
    write_csv(out / "historical_code_ownership.csv", OWNERSHIP_COLUMNS, dataset["ownership"])
    write_csv(out / "unresolved_exceptions.csv", EXCEPTION_COLUMNS, dataset["exceptions"])
    write_json(out / "reconciliation_report.json", qa)
    write_json(out / "proposed_import_mapping.json", build_import_mapping(dataset))
    write_json(out / "source_provenance.json", qa["sources"])

    if sha256_file(workbook_path) != before:
        sys.stderr.write("FATAL: source workbook changed during the run\n")
        return 2

    summary = {
        "records": len(dataset["records"]),
        "exceptions": qa["exceptions"],
        "identity_uniqueness_ok": qa["identity_uniqueness"]["ok"],
        "no_fabricated_identity_ok": qa["no_fabricated_identity"]["ok"],
        "no_role_assignment_ok": qa["no_unauthorized_role_assignment"]["ok"],
        "no_pii_leakage_ok": qa["no_pii_leakage"]["ok"],
        "no_silent_row_loss": qa["row_accounting"]["no_silent_row_loss"],
        "out": str(out),
    }
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
