"""Exact response-byte archive with independent SHA-256 checks; Apache-2.0."""
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .g2b import DATASETS, DataError, unpack


class Archive:
    def __init__(self, directory: str):
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "research.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, collected_at TEXT NOT NULL, dataset TEXT NOT NULL, params TEXT NOT NULL, sha256 TEXT NOT NULL, raw BLOB NOT NULL)")

    def connect(self):
        return sqlite3.connect(self.path, timeout=15)

    def save(self, dataset: str, params: dict, raw: bytes) -> str:
        identifier = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?)", (
                identifier, datetime.now(timezone.utc).isoformat(), dataset,
                json.dumps(params, ensure_ascii=False), hashlib.sha256(raw).hexdigest(), raw))
        return identifier

    def load(self, identifier: str) -> tuple[dict, bytes]:
        with self.connect() as db:
            row = db.execute("SELECT collected_at, dataset, params, sha256, raw FROM snapshots WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise DataError("저장된 snapshot_id를 찾을 수 없습니다.")
        collected_at, dataset, params, digest, raw = row
        if hashlib.sha256(raw).hexdigest() != digest:
            raise DataError("보관 원문의 해시 검증에 실패했습니다. 이 자료를 분석에 사용하지 마세요.")
        definition = DATASETS[dataset]
        return {"snapshot_id": identifier, "collected_at_utc": collected_at, "dataset": dataset,
                "source": definition.source, "endpoint": f"{definition.service}/{definition.operation}",
                "request_without_key": json.loads(params), "sha256": digest, "byte_count": len(raw),
                "integrity_verified": True}, raw

    def read_rows(self, identifier: str, offset: int = 0, limit: int = 3) -> dict:
        if offset < 0 or not 1 <= limit <= 10:
            raise DataError("offset은 0 이상, limit은 1~10입니다.")
        meta, raw = self.load(identifier)
        items, total, page, rows = unpack(json.loads(raw))
        selection = items[offset:offset + limit]
        if len(json.dumps(selection, ensure_ascii=False)) > 80000:
            raise DataError("행이 큽니다. limit을 줄이거나 read_raw_snapshot으로 원문을 나눠 읽으세요.")
        next_offset = offset + len(selection)
        return {**meta, "source_total_count": total, "source_page": page, "source_page_size": rows,
                "stored_rows": len(items), "offset": offset, "rows": selection,
                "next_offset": next_offset if next_offset < len(items) else None,
                "fields_omitted": False}

    def read_raw(self, identifier: str, offset: int = 0, characters: int = 12000) -> dict:
        if offset < 0 or not 1 <= characters <= 20000:
            raise DataError("offset은 0 이상, characters는 1~20000입니다.")
        meta, raw = self.load(identifier)
        text = raw.decode("utf-8-sig")
        part = text[offset:offset + characters]
        next_offset = offset + len(part)
        return {**meta, "text": part, "offset": offset, "total_characters": len(text),
                "next_offset": next_offset if next_offset < len(text) else None}

    def recent(self, limit: int = 20) -> list[dict]:
        if not 1 <= limit <= 100:
            raise DataError("limit은 1~100입니다.")
        with self.connect() as db:
            rows = db.execute("SELECT id, collected_at, dataset, params FROM snapshots ORDER BY collected_at DESC LIMIT ?", (limit,)).fetchall()
        return [{"snapshot_id": r[0], "collected_at_utc": r[1], "dataset": r[2], "request_without_key": json.loads(r[3])} for r in rows]
