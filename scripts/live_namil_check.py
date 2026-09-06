"""One live request. Run: python -m scripts.live_namil_check."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from namil.g2b import DataError, fetch_page, make_params, unpack

day = datetime.now(ZoneInfo("Asia/Seoul")) - timedelta(days=1)
params = make_params("notices", start=day.strftime("%Y%m%d") + "0000", end=day.strftime("%Y%m%d") + "2359", rows=1)
try:
    raw, payload = fetch_page("notices", params)
    items, total, _, _ = unpack(payload)
except DataError as error:
    raise SystemExit(str(error)) from None
print(f"API 호출 성공. 전일 등록 공사공고 총 {total}건, 이번 응답 {len(items)}건. 인증값은 출력하지 않습니다.")
