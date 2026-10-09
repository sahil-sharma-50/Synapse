async function checkWebsite(page) {
  const base = "http://127.0.0.1:4173/";
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    document.querySelectorAll("img").forEach((img) => (img.loading = "eager"));
    return document.fonts.ready;
  });
  await page.waitForFunction(() =>
    [...document.images]
      .filter((i) => i.getAttribute("src"))
      .every((i) => i.complete && i.naturalWidth),
  );
  const top = await page.locator(".header-space").boundingBox();
  if (top.y < 15 || top.x < 24 || top.width > 1121) throw Error("Top nav must be inset");
  if (
    (await page.locator(".header-space").evaluate((el) => getComputedStyle(el).borderRadius)) ===
    "0px"
  )
    throw Error("Top nav must be rounded");
  await page.screenshot({ path: "output/playwright/published-home-desktop.png" });
  await page.evaluate(() => scrollTo({ top: 600, behavior: "instant" }));
  await page.waitForFunction(() => {
    const r = document.querySelector(".header-space").getBoundingClientRect();
    return r.y === 0 && Math.abs(r.width - innerWidth) < 1;
  });
  await page.screenshot({ path: "output/playwright/published-home-scrolled.png" });
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForFunction(
    () => document.querySelector(".header-space").getBoundingClientRect().y >= 21,
  );
  await page.locator(".hero-wheel").click();
  const tour = page.locator(".sy-tour");
  for (const tool of await tour.locator("[data-tool]").all()) {
    await tool.click();
    if ((await page.locator("#tour-steps li").count()) !== 3) throw Error("Incomplete tool guide");
  }
  await page.keyboard.press("Escape");
  if (!(await page.locator(".hero-wheel").evaluate((el) => el === document.activeElement)))
    throw Error("Focus restoration");
  for (const summary of await page.locator(".faq summary").all()) {
    await summary.focus();
    await page.keyboard.press("Enter");
    if (!(await summary.evaluate((el) => el.parentElement.open)))
      throw Error("FAQ keyboard failed");
    await page.keyboard.press("Enter");
  }
  await page.locator("#usage a.shot").click();
  if (!(await page.locator(".sy-image-dialog").isVisible())) throw Error("Image zoom");
  await page.keyboard.press("Escape");
  for (const id of ["customize", "usage"]) {
    if (
      !(await page
        .locator("#" + id)
        .evaluate(
          (el) =>
            el.querySelector(".editorial-copy").getBoundingClientRect().right <
            el.querySelector("figure").getBoundingClientRect().left,
        ))
    )
      throw Error("Image layout");
  }
  for (const route of ["", "getting-started/", "privacy/", "404.html"]) {
    await page.goto(base + route, { waitUntil: "networkidle" });
    if ((await page.locator("h1").count()) !== 1) throw Error("Heading on " + route);
    for (const width of [320, 390, 768, 1050, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw Error("Overflow " + route + " " + width);
      if (route === "" && width === 390) {
        await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
        await page.waitForFunction(
          () => document.querySelector(".header-space").getBoundingClientRect().y >= 15,
        );
        await page.screenshot({
          path: "output/playwright/published-home-mobile.png",
          animations: "disabled",
        });
      }
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator("#usage").scrollIntoViewIfNeeded();
  if (await page.evaluate(() => document.getAnimations().length))
    throw Error("Reduced motion ignored");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(base);
  if (errors.length) throw Error(errors.join("; "));
  return "Four routes at five widths; inset-to-full-width nav and return, eight wheel guides, keyboard FAQs, zoom, screenshot layout, reduced motion and console checks pass.";
}
