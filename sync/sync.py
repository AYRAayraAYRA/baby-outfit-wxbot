#!/usr/bin/env python3
"""从公众号收图服务拉取已提交的组，存到 宝宝穿搭/<日期>_公众号_<批次>/原图/01.jpg…

配置文件 ~/.config/baby-outfit-wxbot/.env：
    BASE_URL=https://xxx.sh.run.tcloudbase.com
    SYNC_TOKEN=...
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("BABY_ROOT") or Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/workself/小红书/宝宝穿搭")
ENV_FILE = Path.home() / ".config/baby-outfit-wxbot/.env"


def load_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update({k: v for k, v in os.environ.items() if k in ("BASE_URL", "SYNC_TOKEN")})
    if not env.get("BASE_URL") or not env.get("SYNC_TOKEN"):
        sys.exit(f"缺少 BASE_URL / SYNC_TOKEN，请写到 {ENV_FILE}")
    return env["BASE_URL"].rstrip("/"), env["SYNC_TOKEN"]


BASE, TOKEN = load_env()


def call(path, method="GET"):
    req = urllib.request.Request(BASE + path, method=method, headers={"x-sync-token": TOKEN})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def notify(text):
    subprocess.run(["osascript", "-e", f'display notification "{text}" with title "宝宝穿搭收图" sound name "Glass"'])


def main():
    batches = json.loads(call("/api/batches?status=ready"))["batches"]
    if not batches:
        print("没有新的组")
        return
    for b in batches:
        bid = b["id"]  # 20260918-103000-abc123
        day = f"{bid[0:4]}-{bid[4:6]}-{bid[6:8]}"
        folder = ROOT / f"{day}_公众号_{bid[9:]}"
        raw = folder / "原图"
        raw.mkdir(parents=True, exist_ok=True)

        images = sorted(b["images"], key=lambda im: (im["createTime"], int(im["msgId"])))
        saved, failed = 0, []
        for im in images:
            if not im.get("ok"):
                failed.append(im.get("error", "未上传完成"))
                continue
            saved += 1
            data = call("/api/file?path=" + urllib.parse.quote(im["path"]))
            (raw / f"{saved:02d}.jpg").write_bytes(data)

        (folder / "来源.json").write_text(
            json.dumps({"batch": bid, "openid": b["openid"], "notes": b.get("notes", []),
                        "images": saved, "failed": failed}, ensure_ascii=False, indent=1))
        if b.get("notes"):
            (folder / "备注.txt").write_text("\n".join(b["notes"]))

        call(f"/api/batches/{bid}/ack", method="POST")
        msg = f"新的一组 {saved} 张已存到 {folder.name}" + (f"，{len(failed)} 张失败" if failed else "")
        print(msg)
        notify(msg)


if __name__ == "__main__":
    main()
