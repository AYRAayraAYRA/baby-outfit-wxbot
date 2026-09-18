#!/usr/bin/env python3
"""用固定步骤把一组成品填进小红书并「暂存」为草稿（Playwright，不经过 AI 看网页）。

用法：xhs_draft.py <组目录> [--account main] [--show]
  组目录里要有：封面.jpg、单套/01.png…09.png、文案.md（第一行标题，最后一行 #话题）
  --account  小红书账号代号，每个账号一个独立的浏览器环境（登录状态互不影响）
  --show     显示浏览器窗口（调试用）

需要登录时：把二维码截图上报给公众号服务（发「登录」的成员能拿到），每 40 秒刷新，最多等 15 分钟。
永远不点「发布」：暂存按钮在封闭组件里只能按坐标点，点之前先检查目标位置不是红色的发布按钮，否则中止。
输出最后一行 JSON：{"ok": true} 或 {"ok": false, "error": "..."}
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

PROFILES = Path.home() / ".config/baby-outfit-wxbot/xhs-profiles"
PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?from=menu&target=image"


def report_login(account, png_bytes=None, done=False):
    sys.path.insert(0, str(Path(__file__).parent))
    from pipeline import api  # 延迟导入：只有需要登录时才读同步配置
    if done:
        api(f"/api/login?account={account}", "POST", {"needed": False})
    else:
        api(f"/api/login/qr?account={account}", "POST", png_bytes, "image/png")


def parse_copy(path):
    lines = path.read_text().strip().splitlines()
    title = lines[0].strip().lstrip("#").strip()
    rest = lines[1:]
    topics = []
    if rest and re.fullmatch(r"(\s*#\S+)+\s*", rest[-1]):
        topics = re.findall(r"#(\S+)", rest[-1])
        rest = rest[:-1]
    body = "\n".join(rest).strip()
    return title[:20], body[:950], topics[:10]


def ensure_login(page, account, log):
    page.goto(PUBLISH_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    if "login" not in page.url:
        return True
    log("需要登录，开始上报二维码")
    deadline, last = time.time() + 15 * 60, 0
    try:
        while time.time() < deadline:
            if "login" not in page.url:
                report_login(account, done=True)
                log("登录成功")
                page.goto(PUBLISH_URL, wait_until="domcontentloaded")
                page.wait_for_timeout(3000)
                return True
            if time.time() - last > 40:
                report_login(account, qr_shot(page, reload=last > 0))
                last = time.time()
            page.wait_for_timeout(3000)
    finally:
        if "login" in page.url:
            report_login(account, done=True)  # 超时或出错时撤掉公众号里的登录提示，免得一直挂着旧二维码
    return False


def qr_shot(page, reload=False):
    """登录页默认是短信登录，要点登录框右上角的小图标切到「APP扫一扫登录」，再只截登录框。"""
    if reload:
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
    card = page.locator(".login-box-container").first
    card.wait_for(timeout=15000)
    if "扫一扫" not in card.inner_text():
        card.locator("img").first.click()
        page.wait_for_timeout(2000)
    return card.screenshot()


def upload_images(page, files, log):
    page.locator("input.upload-input").first.set_input_files([str(f) for f in files])
    # 等到编辑区出现，且图片数量对上（页面上显示 "10/18"）
    page.wait_for_selector("input[placeholder='填写标题会有更多赞哦']", timeout=60000)
    for _ in range(60):
        if page.get_by_text(f"{len(files)}/18").count():
            break
        page.wait_for_timeout(1000)
    log(f"已上传 {len(files)} 张图")


def fill_text(page, title, body, topics, log):
    page.fill("input[placeholder='填写标题会有更多赞哦']", title)
    editor = page.locator(".tiptap.ProseMirror").first
    editor.click()
    for i, para in enumerate(body.split("\n")):
        if i:
            page.keyboard.press("Enter")
        if para:
            page.keyboard.insert_text(para)
    page.keyboard.press("Enter")
    for t in topics:
        page.keyboard.insert_text(f"#{t}")
        box = page.locator("#creator-editor-topic-container .item")
        try:
            box.first.wait_for(timeout=5000)
            exact = box.filter(has=page.locator(".name", has_text=re.compile(rf"^#{re.escape(t)}$")))
            (exact.first if exact.count() else box.first).click()
        except PWTimeout:
            page.keyboard.insert_text(" ")  # 没有下拉就当普通文字
        page.wait_for_timeout(400)
    log(f"标题、正文、{len(topics)} 个话题已填好")


def declare_ai(page, log):
    page.get_by_text("添加内容类型声明", exact=True).first.click()
    page.get_by_text("笔记含AI合成内容", exact=True).first.click()
    page.wait_for_timeout(800)
    log("已声明：笔记含AI合成内容")


def is_red(rgb):
    r, g, b = rgb
    return r > 200 and g < 110 and b < 120


def save_draft(page, log):
    from PIL import Image
    import io
    host = page.locator("xhs-publish-btn").first
    host.scroll_into_view_if_needed()
    box = host.bounding_box()
    shot = Image.open(io.BytesIO(host.screenshot())).convert("RGB")
    sx, sy = shot.width / box["width"], shot.height / box["height"]
    cx, cy = box["width"] / 2, box["height"] / 2
    left = shot.getpixel((int((cx - 70) * sx), int(cy * sy)))   # 应该是「暂存离开」（白/灰）
    right = shot.getpixel((int((cx + 70) * sx), int(cy * sy)))  # 应该是「发布」（红）
    if is_red(left) or not is_red(right):
        raise RuntimeError(f"按钮布局和预期不一样（左 {left} 右 {right}），为了不误点发布，已中止")
    page.mouse.click(box["x"] + cx - 70, box["y"] + cy)
    page.wait_for_timeout(4000)
    log("已点「暂存离开」")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--account", default="main")
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()
    folder = Path(a.folder)
    log = lambda *x: print(time.strftime("%H:%M:%S"), *x, flush=True)  # noqa: E731

    files = [folder / "封面.jpg"] + [folder / "单套" / f"{i:02d}.png" for i in range(1, 10)]
    missing = [f.name for f in files if not f.exists()]
    if missing or not (folder / "文案.md").exists():
        print(json.dumps({"ok": False, "error": f"缺文件：{missing or '文案.md'}"}, ensure_ascii=False))
        return 1
    title, body, topics = parse_copy(folder / "文案.md")

    prof = PROFILES / a.account
    prof.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        # 用电脑上装好的 Google Chrome；每个账号一个独立的用户目录，不碰你平时用的 Chrome
        ctx = p.chromium.launch_persistent_context(
            str(prof), channel="chrome", headless=not a.show, viewport={"width": 1280, "height": 860}, locale="zh-CN")
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            if not ensure_login(page, a.account, log):
                raise RuntimeError("15 分钟内没有扫码登录")
            upload_images(page, files, log)
            fill_text(page, title, body, topics, log)
            declare_ai(page, log)
            save_draft(page, log)
            result = {"ok": True}
        except Exception as e:
            page.screenshot(path=str(folder / "小红书_出错截图.png"))
            result = {"ok": False, "error": str(e)[:300]}
        finally:
            ctx.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
