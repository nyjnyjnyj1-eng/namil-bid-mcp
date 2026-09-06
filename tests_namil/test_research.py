import asyncio
import json
from types import SimpleNamespace

import pytest
import requests

from namil.g2b import DataError, fetch_page, make_params, unpack
from namil.store import Archive


def payload(count=12, total=None, page=1, rows=20):
    return {"response": {"header": {"resultCode": "00", "resultMsg": "정상"}, "body": {
        "items": [{"bidNtceNo": f"R26BK{i:08}", "bidNtceOrd": "001", "unusual_field": "원문 보존" * 100} for i in range(count)],
        "totalCount": count if total is None else total, "pageNo": page, "numOfRows": rows}}}


@pytest.mark.parametrize("dataset,mode", [("notices", "2"), ("base_amounts", "2"),
    ("opening_results", "4"), ("preliminary_prices", "2"), ("awards", "4")])
def test_official_notice_number_modes(dataset, mode):
    assert make_params(dataset, notice_number="R26BK00000001")["inqryDiv"] == mode


def test_ranks_preserve_order_and_rebid_strings():
    p = make_params("bidder_ranks", notice_number="R26BK00000001", notice_order="001", rebid_number="000")
    assert p["bidNtceOrd"] == "001" and p["rbidNo"] == "000"
    assert "inqryDiv" not in p


@pytest.mark.parametrize("kwargs", [
    {"dataset": "notices", "notice_number": "R26BK00000001", "start": "202609010000"},
    {"dataset": "notices", "start": "202609010000", "end": "202609082359"},
    {"dataset": "notices", "start": "202602300000", "end": "202603012359"},
    {"dataset": "bidder_ranks"},
    {"dataset": "preliminary_prices", "start": "202609010000", "end": "202609012359", "date_basis": "opened"},
    {"dataset": "notices", "notice_number": "R26BK00000001", "rows": 101},
])
def test_invalid_or_ambiguous_queries_are_rejected(kwargs):
    with pytest.raises(DataError):
        make_params(**kwargs)


def test_archive_keeps_every_row_and_original_byte(tmp_path):
    source = payload()
    raw = json.dumps(source, ensure_ascii=False, indent=2).encode()
    store = Archive(str(tmp_path))
    identifier = store.save("notices", make_params("notices", notice_number="R26BK00000001"), raw)
    reloaded = Archive(str(tmp_path))
    assert reloaded.load(identifier)[1] == raw
    rows = []
    cursor = 0
    while cursor is not None:
        result = reloaded.read_rows(identifier, offset=cursor, limit=3)
        rows.extend(result["rows"])
        cursor = result["next_offset"]
    assert rows == source["response"]["body"]["items"]
    text, cursor = "", 0
    while cursor is not None:
        result = reloaded.read_raw(identifier, cursor, 200)
        text += result["text"]
        cursor = result["next_offset"]
    assert text.encode() == raw


def test_archive_detects_corruption(tmp_path):
    store = Archive(str(tmp_path))
    identifier = store.save("notices", {}, json.dumps(payload()).encode())
    with store.connect() as db:
        db.execute("UPDATE snapshots SET raw=? WHERE id=?", (b"{}", identifier))
    with pytest.raises(DataError, match="해시"):
        store.load(identifier)


def test_business_error_is_not_empty_success():
    with pytest.raises(DataError, match="업무 오류"):
        unpack({"response": {"header": {"resultCode": "30", "resultMsg": "private diagnostic"}}})
    assert unpack(payload(count=0))[0] == []


class Response:
    def __init__(self, raw, status=200):
        self.raw, self.status_code = raw, status
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def iter_content(self, chunk_size):
        yield self.raw


def test_https_key_encoding_and_no_redirects(monkeypatch):
    monkeypatch.setenv("NARAMARKET_SERVICE_KEY", "fake%2Bsecret%2Fvalue%3D")
    raw = json.dumps(payload()).encode()
    captured = {}
    def get(url, **kwargs):
        captured.update(url=url, **kwargs)
        return Response(raw)
    monkeypatch.setattr(requests, "get", get)
    fetched, _ = fetch_page("notices", make_params("notices", notice_number="R26BK00000001"))
    assert fetched == raw
    assert captured["url"].startswith("https://apis.data.go.kr/")
    assert captured["params"]["serviceKey"] == "fake+secret/value="
    assert captured["allow_redirects"] is False


def test_connection_error_never_exposes_secret(monkeypatch, caplog):
    key = "fake-secret-not-for-exposure"
    monkeypatch.setenv("NARAMARKET_SERVICE_KEY", key)
    monkeypatch.setattr("namil.g2b.time.sleep", lambda _: None)
    def fail(*args, **kwargs):
        raise requests.ConnectionError("https://apis.data.go.kr/?serviceKey=" + key)
    monkeypatch.setattr(requests, "get", fail)
    with pytest.raises(DataError) as result:
        fetch_page("notices", make_params("notices", notice_number="R26BK00000001"))
    assert key not in str(result.value) and key not in caplog.text


def test_rejects_echoed_key_and_wrong_page(monkeypatch):
    key = "fake-secret-value-for-test"
    monkeypatch.setenv("NARAMARKET_SERVICE_KEY", key)
    p = make_params("notices", notice_number="R26BK00000001")
    monkeypatch.setattr(requests, "get", lambda *a, **kw: Response(key.encode()))
    with pytest.raises(DataError, match="인증값"):
        fetch_page("notices", p)
    monkeypatch.setattr(requests, "get", lambda *a, **kw: Response(json.dumps(payload(page=2)).encode()))
    with pytest.raises(DataError, match="페이지 정보"):
        fetch_page("notices", p)


def test_key_override_is_rejected(monkeypatch):
    monkeypatch.setenv("NARAMARKET_SERVICE_KEY", "fake-secret-value-for-test")
    with pytest.raises(DataError, match="인증값"):
        fetch_page("notices", {"serviceKey": "other"})


def test_production_fails_closed_without_auth(monkeypatch, tmp_path):
    from namil.server import create_server
    for key in ("NAMIL_BASE_URL", "NAMIL_GITHUB_CLIENT_ID", "NAMIL_GITHUB_CLIENT_SECRET",
                "NAMIL_ALLOWED_GITHUB_IDS", "NAMIL_JWT_SIGNING_KEY", "NAMIL_STORAGE_KEY"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(ValueError, match="배포 설정 누락"):
        create_server(mode="production", directory=str(tmp_path))
    monkeypatch.setenv("RENDER", "true")
    with pytest.raises(ValueError, match="local"):
        create_server(mode="local", directory=str(tmp_path))


def test_owner_filter_blocks_other_github_accounts(monkeypatch):
    from namil.server import GitHubProvider, OwnerGitHubProvider
    provider = object.__new__(OwnerGitHubProvider)
    provider.allowed_user_ids = {"12345"}
    async def fake_verify(self, token):
        return SimpleNamespace(claims={"sub": token})
    monkeypatch.setattr(GitHubProvider, "verify_token", fake_verify)
    assert asyncio.run(provider.verify_token("12345")) is not None
    assert asyncio.run(provider.verify_token("67890")) is None


def test_mcp_discovery_query_pagination_and_full_row_read(monkeypatch, tmp_path):
    from fastmcp import Client
    from namil.server import create_server
    monkeypatch.delenv("RENDER", raising=False)
    p = payload(count=20, total=21)
    monkeypatch.setattr("namil.server.fetch_page", lambda *args: (json.dumps(p).encode(), p))
    server = create_server(mode="local", directory=str(tmp_path))
    async def scenario():
        async with Client(server) as client:
            tools = await client.list_tools()
            assert len(tools) == 5
            result = await client.call_tool("query_construction_page", {"dataset": "notices", "notice_number": "R26BK00000001"})
            data = result.data
            assert data["next_page"] == 2 and data["rows_saved"] == 20
            assert data["preview_is_partial"] and len(data["preview"]) == 5
            assert data["query_complete_in_this_snapshot"] is False
            saved = await client.call_tool("read_saved_rows", {"snapshot_id": data["snapshot_id"], "offset": 19, "limit": 1})
            assert saved.data["rows"][0]["unusual_field"] == "원문 보존" * 100
    asyncio.run(scenario())


def test_production_http_requires_login_and_advertises_oauth(monkeypatch, tmp_path):
    import httpx
    from cryptography.fernet import Fernet
    from namil.server import create_server
    settings = {
        "NAMIL_BASE_URL": "https://example.test", "NAMIL_GITHUB_CLIENT_ID": "test-client-id",
        "NAMIL_GITHUB_CLIENT_SECRET": "test-client-secret", "NAMIL_ALLOWED_GITHUB_IDS": "12345",
        "NAMIL_JWT_SIGNING_KEY": "test-only-signing-material-" * 3,
        "NAMIL_STORAGE_KEY": Fernet.generate_key().decode(),
    }
    for name, value in settings.items():
        monkeypatch.setenv(name, value)
    server = create_server(mode="production", directory=str(tmp_path))
    app = server.http_app(path="/mcp", stateless_http=True)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://example.test") as client:
            health = await client.get("/healthz")
            assert health.status_code == 200 and health.json()["mode"] == "production"
            denied = await client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            assert denied.status_code == 401
            metadata = await client.get("/.well-known/oauth-authorization-server")
            assert metadata.status_code == 200
            assert metadata.json()["authorization_endpoint"].startswith("https://example.test/")
    asyncio.run(scenario())
