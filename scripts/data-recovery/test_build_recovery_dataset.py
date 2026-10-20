"""Regression tests for the employee-master recovery pipeline (synthetic data only)."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_recovery_dataset as rec  # noqa: E402


def synthetic_national_id(seed: int) -> str:
    prefix = f"9{seed:011d}"
    total = sum(int(d) * (13 - i) for i, d in enumerate(prefix))
    return f"{prefix}{(11 - total % 11) % 10}"


def write_workbook(path: Path, rows: list[list]) -> None:
    wb = Workbook()
    ws = wb.active
    ws.append([f"col{i}" for i in range(10)])
    for row in rows:
        ws.append(row)
    wb.save(path)


def write_csv(path: Path, rows: list[list], *, bom: bool = True, encoding: str = "utf-8") -> None:
    header = ["ID card Code", "Facescan Code", "name", "หน่วยงาน"]
    body = "\n".join([",".join(header)] + [",".join(map(str, r)) for r in rows]) + "\n"
    data = body.encode(encoding)
    if bom:
        data = b"\xef\xbb\xbf" + data
    path.write_bytes(data)


def wb_row(code, status="ยืนยันรหัสจากข้อมูลปี 2026", csv_name="", csv_dept="",
           owner_name="", owner_code="", owner_dept="", owner_status="ปฏิบัติงาน",
           note="ยืนยัน", title="นาย"):
    return [code, status, csv_name, csv_dept, owner_name, owner_code, owner_dept,
            owner_status, note, title]


class NormalizationTests(unittest.TestCase):
    def test_bom_aware_decode(self):
        text, enc = rec.decode_csv_bytes(b"\xef\xbb\xbfID card Code,Facescan Code\n")
        self.assertEqual(enc, "utf-8-sig(BOM)")
        self.assertTrue(text.startswith("ID card Code"))
        text2, enc2 = rec.decode_csv_bytes("กอง,1\n".encode("utf-8"))
        self.assertEqual(enc2, "utf-8")
        self.assertEqual(text2, "กอง,1\n")

    def test_cp874_fallback_is_flagged(self):
        _, enc = rec.decode_csv_bytes("หน่วยงาน".encode("cp874"))
        self.assertTrue(enc.startswith("cp874"))

    def test_normalize_code_keeps_leading_zeros_and_flags_number_cells(self):
        self.assertEqual(rec.normalize_code(" 0012 "), ("0012", None))
        self.assertEqual(rec.normalize_code(12), ("12", "CODE_STORED_AS_NUMBER"))
        self.assertEqual(rec.normalize_code("A12"), ("", "CODE_NOT_DIGITS"))
        self.assertEqual(rec.normalize_code(None), ("", None))

    def test_employment_status_variants(self):
        self.assertEqual(rec.classify_employment("ปฏิบัติงาน"), ("active", None))
        self.assertEqual(rec.classify_employment("ปฎิบัติงาน"),
                         ("active", "EMPLOYMENT_STATUS_SPELLING_VARIANT"))
        self.assertEqual(rec.classify_employment("ลาออก"), ("resigned", None))
        self.assertEqual(rec.classify_employment("เกษียณอายุ/ลาออก"), ("resigned", None))
        self.assertEqual(rec.classify_employment("??"), ("UNKNOWN", "EMPLOYMENT_STATUS_UNRECOGNIZED"))

    def test_name_is_never_split(self):
        self.assertEqual(rec.split_owner_name("นาย ทดสอบ ระบบ"), ("นาย ทดสอบ ระบบ", ""))


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rae-rec-"))
        self.wb = self.tmp / "roster.xlsx"
        self.csv = self.tmp / "idcard.csv"

    def build(self, wb_rows, csv_rows, **csv_opts):
        write_workbook(self.wb, wb_rows)
        write_csv(self.csv, csv_rows, **csv_opts)
        before = hashlib.sha256(self.wb.read_bytes()).hexdigest()
        workbook = rec.read_workbook(self.wb)
        idcard = rec.read_idcard_csv(self.csv)
        dataset = rec.build_dataset(workbook, idcard)
        self.assertEqual(hashlib.sha256(self.wb.read_bytes()).hexdigest(), before,
                         "source workbook must never be modified")
        return workbook, idcard, dataset

    def test_exact_duplicate_collapses_and_no_silent_row_loss(self):
        wb_rows = [
            wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                   owner_code="1000", owner_dept="กองเอ"),
        ]
        csv_rows = [
            [synthetic_national_id(1), "1000", "ก ข", "กองเอ"],
            [synthetic_national_id(1), "1000", "ก ข", "กองเอ"],
        ]
        workbook, idcard, dataset = self.build(wb_rows, csv_rows)
        self.assertEqual(len(idcard["rows"]), 2)
        self.assertEqual(len(dataset["csv_unique"]), 1)
        self.assertEqual(len(dataset["records"]), 1)
        self.assertEqual(dataset["records"][0]["csv_duplicate_rows"], "3")
        self.assertTrue(rec.run_qa(workbook, idcard, dataset)["row_accounting"]["no_silent_row_loss"])

    def test_same_device_code_different_people_is_a_blocker(self):
        wb_rows = [wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                          owner_code="1000", owner_dept="กองเอ")]
        csv_rows = [
            [synthetic_national_id(1), "1000", "ก ข", "กองเอ"],
            [synthetic_national_id(2), "1000", "ค ง", "กองเอ"],
        ]
        workbook, idcard, dataset = self.build(wb_rows, csv_rows)
        report = rec.run_qa(workbook, idcard, dataset)
        self.assertEqual(report["code_ownership"]["csv_ambiguous_codes"], ["1000"])
        self.assertFalse(report["code_ownership"]["ok"])
        self.assertIn("CSV_CODE_AMBIGUOUS",
                      [e["exception_type"] for e in dataset["exceptions"]])

    def test_missing_device_code_for_master_only_row(self):
        wb_rows = [wb_row("1015", status="มีใน Master แต่ไม่พบสแกน", owner_name="",
                          owner_code="", owner_dept="", owner_status="ลาออก", note="ลาออก")]
        workbook, idcard, dataset = self.build(wb_rows, [])
        record = dataset["records"][0]
        self.assertEqual(record["device_code"], "")
        types = [e["exception_type"] for e in dataset["exceptions"]]
        self.assertIn("MASTER_ONLY_NO_SCAN", types)
        self.assertIn("EMPLOYEE_CODE_MISSING", types)
        self.assertIn("OWNER_NAME_MISSING", types)

    def test_department_change_is_recorded_not_hidden(self):
        wb_rows = [wb_row("1000", csv_name="ก ข", csv_dept="กองเก่า", owner_name="ก ข",
                          owner_code="1000", owner_dept="กองใหม่")]
        csv_rows = [[synthetic_national_id(1), "1000", "ก ข", "กองเก่า"]]
        _, _, dataset = self.build(wb_rows, csv_rows)
        changes = [e for e in dataset["exceptions"] if e["exception_type"] == "DEPARTMENT_CHANGED"]
        self.assertEqual(len(changes), 1)
        self.assertEqual(dataset["records"][0]["department_reference_2027"], "กองเก่า")
        self.assertEqual(dataset["records"][0]["department_current"], "กองใหม่")

    def test_unmatched_csv_person_is_not_dropped(self):
        wb_rows = [wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                          owner_code="1000", owner_dept="กองเอ")]
        csv_rows = [
            [synthetic_national_id(1), "1000", "ก ข", "กองเอ"],
            [synthetic_national_id(2), "1001", "ค ง", "กองเอ"],
        ]
        _, _, dataset = self.build(wb_rows, csv_rows)
        self.assertIn("CSV_PERSON_NOT_IN_REPORT",
                      [e["exception_type"] for e in dataset["exceptions"]])
        self.assertEqual(len(dataset["csv_unique"]), 2)

    def test_no_fabricated_identity_and_no_role(self):
        wb_rows = [wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                          owner_code="1000", owner_dept="กองเอ")]
        csv_rows = [[synthetic_national_id(1), "1000", "ก ข", "กองเอ"]]
        workbook, idcard, dataset = self.build(wb_rows, csv_rows)
        report = rec.run_qa(workbook, idcard, dataset)
        self.assertTrue(report["no_fabricated_identity"]["ok"])
        self.assertEqual(report["no_fabricated_identity"]["sso_subject_values"], [""])
        self.assertTrue(report["no_unauthorized_role_assignment"]["ok"])
        for row in dataset["master"]:
            self.assertEqual(row["role"], "")
            self.assertEqual(row["identity_kind"], "UNRESOLVED")
            self.assertEqual(row["email"], "")
            self.assertEqual(row["personnel_id"], "")

    def test_national_id_is_never_emitted(self):
        national_id = synthetic_national_id(7)
        wb_rows = [wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                          owner_code="1000", owner_dept="กองเอ")]
        csv_rows = [[national_id, "1000", "ก ข", "กองเอ"]]
        workbook, idcard, dataset = self.build(wb_rows, csv_rows)
        report = rec.run_qa(workbook, idcard, dataset)
        self.assertTrue(report["no_pii_leakage"]["ok"])
        for row in dataset["master"]:
            self.assertNotIn(national_id, json.dumps(row, ensure_ascii=False))
            self.assertNotIn(national_id, row["national_id_source_ref"])

    def test_duplicate_employee_code_is_detected(self):
        wb_rows = [
            wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                   owner_code="2000", owner_dept="กองเอ"),
            wb_row("1001", csv_name="ค ง", csv_dept="กองเอ", owner_name="ค ง",
                   owner_code="2000", owner_dept="กองเอ"),
        ]
        csv_rows = [
            [synthetic_national_id(1), "1000", "ก ข", "กองเอ"],
            [synthetic_national_id(2), "1001", "ค ง", "กองเอ"],
        ]
        workbook, idcard, dataset = self.build(wb_rows, csv_rows)
        report = rec.run_qa(workbook, idcard, dataset)
        self.assertEqual(report["identity_uniqueness"]["duplicate_employee_codes"], ["2000"])
        self.assertFalse(report["identity_uniqueness"]["ok"])

    def test_untraceable_reference_name_blocks(self):
        wb_rows = [wb_row("1031", status="ข้อมูลล่าสุด", csv_name="ใหม่ มาก",
                          csv_dept="กองเอ", owner_name="ใหม่ มาก", owner_code="1031",
                          owner_dept="กองเอ", note="ยืนยัน/พนักงานใหม่")]
        _, _, dataset = self.build(wb_rows, [])
        types = [e["exception_type"] for e in dataset["exceptions"]]
        self.assertIn("CSV_REFERENCE_UNTRACEABLE", types)
        self.assertEqual(dataset["records"][0]["match_method"], "UNTRACEABLE_NAME_ONLY")

    def test_end_to_end_writes_only_under_out_dir(self):
        wb_rows = [wb_row("1000", csv_name="ก ข", csv_dept="กองเอ", owner_name="ก ข",
                          owner_code="1000", owner_dept="กองเอ")]
        write_workbook(self.wb, wb_rows)
        write_csv(self.csv, [[synthetic_national_id(1), "1000", "ก ข", "กองเอ"]])
        out = self.tmp / "out"
        rc = rec.main(["--workbook", str(self.wb), "--csv", str(self.csv), "--out", str(out)])
        self.assertEqual(rc, 0)
        for name in ("normalized_employee_master.csv", "identity_reconciliation.csv",
                     "historical_code_ownership.csv", "unresolved_exceptions.csv",
                     "reconciliation_report.json", "proposed_import_mapping.json",
                     "source_provenance.json"):
            self.assertTrue((out / name).exists(), name)


if __name__ == "__main__":
    unittest.main()
