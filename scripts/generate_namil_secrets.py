"""Create deployment secrets once, without printing them or overwriting a file."""
import os
import secrets
from cryptography.fernet import Fernet

target = ".env.deployment"
try:
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit(".env.deployment가 이미 있습니다. 기존 비밀값을 유지합니다.")
with os.fdopen(descriptor, "w") as handle:
    handle.write("NAMIL_JWT_SIGNING_KEY=" + secrets.token_urlsafe(48) + "\n")
    handle.write("NAMIL_STORAGE_KEY=" + Fernet.generate_key().decode() + "\n")
print(".env.deployment를 만들었습니다. 파일에서 값을 복사해 호스팅 비밀값에 넣으세요. 채팅이나 GitHub에 올리지 마세요.")
