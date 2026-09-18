#!/usr/bin/env python3
"""在 Mac 上打开某个小红书账号专用的浏览器窗口，让人自己登录（短信或扫码都行）。登录成功后自动关闭。
用法：xhs_open_login.py [--account main]
"""
import argparse
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--account", default="main")
a = ap.parse_args()
prof = Path.home() / ".config/baby-outfit-wxbot/xhs-profiles" / a.account
prof.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(str(prof), channel="chrome", headless=False,
                                               viewport={"width": 1280, "height": 860}, locale="zh-CN")
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://creator.xiaohongshu.com/publish/publish?from=menu&target=image")
    page.bring_to_front()
    print("窗口已打开，请在窗口里自己登录（最多等 20 分钟）", flush=True)
    for _ in range(400):
        page.wait_for_timeout(3000)
        if "login" not in page.url:
            print("登录成功", flush=True)
            time.sleep(3)
            break
    else:
        print("超时未登录", flush=True)
    ctx.close()
