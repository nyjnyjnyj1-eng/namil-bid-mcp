"""Key-free setup check. Run at repository root: python scripts/check_namil.py."""
import os
import sys
from importlib.metadata import version, PackageNotFoundError

print("Python:", sys.version.split()[0])
failed = False
for name in ("fastmcp", "requests", "python-dotenv", "py-key-value-aio"):
    try:
        print(name + ":", version(name))
    except PackageNotFoundError:
        print(name + ": 설치 필요")
        failed = True
print("NARAMARKET_SERVICE_KEY:", "등록됨 (값은 표시하지 않음)" if os.environ.get("NARAMARKET_SERVICE_KEY") else "미등록 (오프라인 테스트 가능)")
raise SystemExit(1 if failed else 0)
