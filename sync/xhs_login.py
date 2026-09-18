#!/usr/bin/env python3
"""小红书需要扫码登录时，把二维码截图上报给公众号服务，本人在公众号里发「登录」就能拿到链接。
用法：xhs_login.py qr <截图.png>   上报/刷新二维码
      xhs_login.py done            登录成功，清掉二维码
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pipeline import api  # noqa: E402

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "qr":
        api("/api/login/qr", "POST", Path(sys.argv[2]).read_bytes(), "image/png")
        print("二维码已上报")
    elif len(sys.argv) == 2 and sys.argv[1] == "done":
        api("/api/login", "POST", {"needed": False})
        print("已清除登录提醒")
    else:
        sys.exit(__doc__)
