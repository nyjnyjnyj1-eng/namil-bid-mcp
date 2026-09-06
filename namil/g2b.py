"""Read-only construction API adapter. Added 2026-09-06; Apache-2.0.

Operation names and inquiry modes follow the data.go.kr reference manuals.
This entry point does not import the upstream shopping/crawler clients.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, unquote

import requests


class DataError(ValueError):
    """A public, sanitized error; never include a request URL or credential."""


@dataclass(frozen=True)
class Dataset:
    label: str
    service: str
    operation: str
    source: str
    modes: dict[str, str]


NOTICE = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService"
RESULT = "https://apis.data.go.kr/1230000/as/ScsbidInfoService"
NOTICE_DOC = "https://www.data.go.kr/data/15129394/openapi.do"
RESULT_DOC = "https://www.data.go.kr/data/15129397/openapi.do"
DATASETS = {
    "notices": Dataset("공사 입찰공고", NOTICE, "getBidPblancListInfoCnstwk", NOTICE_DOC,
                       {"registered": "1", "notice_number": "2", "changed": "3"}),
    "base_amounts": Dataset("공사 기초금액", NOTICE, "getBidPblancListInfoCnstwkBsisAmount", NOTICE_DOC,
                           {"registered": "1", "notice_number": "2"}),
    "opening_results": Dataset("공사 개찰결과", RESULT, "getOpengResultListInfoCnstwk", RESULT_DOC,
                              {"registered": "1", "announced": "2", "opened": "3", "notice_number": "4"}),
    "bidder_ranks": Dataset("개찰완료 업체별 순위", RESULT, "getOpengResultListInfoOpengCompt", RESULT_DOC, {}),
    "preliminary_prices": Dataset("공사 예비가격 상세", RESULT, "getOpengResultListInfoCnstwkPreparPcDetail", RESULT_DOC,
                                 {"registered": "1", "notice_number": "2"}),
    "awards": Dataset("공사 낙찰자 현황", RESULT, "getScsbidListSttusCnstwk", RESULT_DOC,
                      {"registered": "1", "announced": "2", "opened": "3", "notice_number": "4"}),
}


def make_params(dataset: str, *, start: str = "", end: str = "", notice_number: str = "",
                date_basis: str = "registered", page: int = 1, rows: int = 20,
                notice_order: str = "", classification_number: str = "", rebid_number: str = "") -> dict:
    if dataset not in DATASETS:
        raise DataError("지원하지 않는 dataset입니다. research_capabilities를 확인하세요.")
    if not 1 <= page <= 9999 or not 1 <= rows <= 100:
        raise DataError("page는 1~9999, rows는 1~100이어야 합니다.")
    p: dict[str, Any] = {"pageNo": page, "numOfRows": rows, "type": "json"}
    definition = DATASETS[dataset]
    if notice_number:
        if start or end or date_basis != "registered":
            raise DataError("공고번호 조회에는 날짜 조건을 함께 넣지 마세요.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", notice_number):
            raise DataError("공고번호 형식을 확인하세요. 공고차수는 별도 항목입니다.")
        p["bidNtceNo"] = notice_number
        if dataset != "bidder_ranks":
            p["inqryDiv"] = definition.modes["notice_number"]
    else:
        if dataset == "bidder_ranks":
            raise DataError("업체별 순위 조회에는 notice_number가 필요합니다.")
        if date_basis not in definition.modes or date_basis == "notice_number":
            raise DataError("이 자료에서 지원하는 날짜 기준을 research_capabilities에서 확인하세요.")
        if not re.fullmatch(r"\d{12}", start) or not re.fullmatch(r"\d{12}", end):
            raise DataError("start/end는 한국시간 YYYYMMDDHHMM 형식입니다.")
        try:
            begin, finish = (datetime.strptime(v, "%Y%m%d%H%M") for v in (start, end))
        except ValueError:
            raise DataError("존재하지 않는 날짜 또는 시간입니다.") from None
        if finish < begin or finish - begin >= timedelta(days=7):
            raise DataError("이 프로그램은 호출량 관리를 위해 한 번에 최대 7일 미만의 시간차를 허용합니다. 기간을 나눠 조회하세요.")
        p.update(inqryDiv=definition.modes[date_basis], inqryBgnDt=start, inqryEndDt=end)
    identifiers = {"bidNtceOrd": notice_order, "bidClsfcNo": classification_number, "rbidNo": rebid_number}
    if any(identifiers.values()) and dataset != "bidder_ranks":
        raise DataError("공고차수·분류번호·재입찰번호 입력은 bidder_ranks 조회에서만 지원합니다. 다른 자료는 응답의 식별자로 구분하세요.")
    for name, value in identifiers.items():
        if value:
            if not re.fullmatch(r"\d{1,5}", value):
                raise DataError("공고차수·분류번호·재입찰번호는 최대 5자리 숫자 문자열입니다.")
            p[name] = value
    return p


def unpack(payload: dict) -> tuple[list[dict], int, int, int]:
    try:
        response = payload["response"]
        code = str(response["header"]["resultCode"])
    except (KeyError, TypeError):
        raise DataError("공식 JSON 응답 형식이 아닙니다. 인증키·활용신청·서비스 상태를 확인하세요.") from None
    if code not in {"00", "0", "0000"}:
        safe_code = code if re.fullmatch(r"[A-Za-z0-9_-]{1,20}", code) else "UNKNOWN"
        raise DataError(f"공공데이터 API 업무 오류({safe_code}). 인증키·승인 상태·조회 조건·호출 한도를 확인하세요.")
    try:
        body = response["body"]
        items = body.get("items")
        if isinstance(items, dict):
            items = items.get("item", [])
            if isinstance(items, dict):
                items = [items]
        if items is None or items == "":
            items = []
        total, page, rows = (int(body[k]) for k in ("totalCount", "pageNo", "numOfRows"))
        if not isinstance(items, list) or not all(isinstance(x, dict) for x in items):
            raise ValueError
        if total < 0 or page < 1 or rows < 1 or len(items) > rows:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise DataError("응답 본문 또는 페이지 정보가 명세와 다릅니다. 전체 수집으로 판단하지 마세요.") from None
    return items, total, page, rows


def fetch_page(dataset: str, params: dict) -> tuple[bytes, dict]:
    """No redirects, no arbitrary URLs, no raw exception/log output containing keys."""
    definition = DATASETS[dataset]
    key = os.environ.get("NARAMARKET_SERVICE_KEY", "").strip()
    if not key or key in {"your-api-key-here", "PASTE_YOUR_KEY_HERE"}:
        raise DataError("NARAMARKET_SERVICE_KEY가 없습니다. 채팅이 아닌 Codespaces/호스팅의 비밀값에 등록하세요.")
    key = unquote(key)  # Requests encodes once; accepts the portal's encoded or decoded value.
    if any("key" in k.lower() or "token" in k.lower() for k in params):
        raise DataError("인증값은 도구 인수로 받을 수 없습니다.")
    url = f"{definition.service}/{definition.operation}"
    query = {**params, "serviceKey": key}
    raw = b""
    for attempt in range(3):
        try:
            with requests.get(url, params=query, timeout=(5, 25), allow_redirects=False, stream=True) as response:
                status = response.status_code
                if status == 429 or 500 <= status < 600:
                    if attempt < 2:
                        time.sleep(0.5 * 2 ** attempt)
                        continue
                    raise DataError(f"공공데이터 API 일시 오류(HTTP {status}). 잠시 후 다시 조회하세요.")
                if status != 200:
                    raise DataError(f"공공데이터 API HTTP {status}. 서비스 승인과 인증키 설정을 확인하세요.")
                chunks, size = [], 0
                for chunk in response.iter_content(chunk_size=65536):
                    size += len(chunk)
                    if size > 10 * 1024 * 1024:
                        raise DataError("응답이 10MB를 넘었습니다. rows를 줄여 다시 조회하세요.")
                    chunks.append(chunk)
                raw = b"".join(chunks)
            break
        except (requests.Timeout, requests.ConnectionError):
            if attempt < 2:
                time.sleep(0.5 * 2 ** attempt)
                continue
            raise DataError("공공데이터 API 연결/시간초과 오류. 잠시 후 다시 조회하세요.") from None
        except requests.RequestException:
            raise DataError("공공데이터 API 통신 오류. 서버의 네트워크 설정을 확인하세요.") from None
    if any(secret.encode() in raw for secret in {key, quote(key, safe="")}):
        raise DataError("응답에 인증값이 포함되어 보관과 반환을 중단했습니다.")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise DataError("JSON 응답이 아닙니다. 인증키·활용신청·서비스 상태를 확인하세요.") from None
    _, _, actual_page, actual_rows = unpack(payload)
    if actual_page != params["pageNo"] or actual_rows != params["numOfRows"]:
        raise DataError("요청과 응답의 페이지 정보가 다릅니다. 누락 방지를 위해 수집을 중단했습니다.")
    return raw, payload
