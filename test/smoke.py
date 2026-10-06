import asyncio, sys
from playwright.async_api import async_playwright
PATH = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/kingnode/app.html"
async def main():
    async with async_playwright() as pw:
        br=await pw.chromium.launch(); pg=await br.new_page(viewport={"width":1440,"height":1000})
        errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        await pg.route("**/api/**", lambda r: r.fulfill(status=502, json={"error":"x"}))
        await pg.route("https://**", lambda r: r.fulfill(status=404, body=""))
        await pg.route("http://t/app.html**", lambda r: r.fulfill(path=PATH))
        await pg.goto("http://t/app.html"); await pg.wait_for_timeout(1500)
        if await pg.locator("#startDlg[open]").count(): await pg.click("#startDone"); await pg.wait_for_timeout(200)
        groups = await pg.locator(".tab-g[role=tab]").all_inner_texts()
        for g in groups:
            await pg.click(f".tab-g:has-text('{g}')"); await pg.wait_for_timeout(200)
            subs = await pg.locator(".tabs-secondary .tab").all_inner_texts()
            for t in subs:
                await pg.click(f".tabs-secondary .tab:has-text('{t}')"); await pg.wait_for_timeout(350)
        await pg.click("#settingsBtn"); await pg.wait_for_timeout(200); await pg.keyboard.press("Escape")
        print("errors:", errs); await br.close()
asyncio.run(main())
