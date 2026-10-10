async function checkWebsite(page) {
  const base = new URL("./", page.url()).href;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page.evaluate(() => localStorage.removeItem("synapse-theme"));
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
  const atTop = () =>
    page.locator(".header-space").evaluate((el) => {
      const style = getComputedStyle(el);
      return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.backdropFilter === "none";
    });
  if (!(await atTop())) throw Error("Top nav must be transparent without blur");
  await page.screenshot({
    path: "output/playwright/chaiui-home-desktop.png",
    animations: "disabled",
  });
  await page.evaluate(() => scrollTo({ top: 600, behavior: "instant" }));
  await page.waitForFunction(() => {
    const header = document.querySelector(".header-space");
    return (
      header.classList.contains("is-scrolled") && getComputedStyle(header).backdropFilter !== "none"
    );
  });
  await page.screenshot({
    path: "output/playwright/chaiui-home-scrolled.png",
    animations: "disabled",
  });
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForFunction(
    () => !document.querySelector(".header-space").classList.contains("is-scrolled"),
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
  for (const theme of ["dark", "light"]) {
    if (theme === "light") {
      await page.locator("[data-toggle-theme]").click();
      await page.reload({ waitUntil: "networkidle" });
      if ((await page.locator("html").getAttribute("data-theme")) !== "light")
        throw Error("Theme persistence");
      await page.screenshot({
        path: "output/playwright/chaiui-home-light.png",
        animations: "disabled",
      });
    }
    for (const route of ["", "getting-started/", "privacy/", "404.html"]) {
      await page.goto(base + route, { waitUntil: "networkidle" });
      if ((await page.locator("h1").count()) !== 1) throw Error("Heading on " + route);
      if (theme === "light" && (await page.locator("html").getAttribute("data-theme")) !== "light")
        throw Error("Theme across routes");
      for (const width of [320, 375, 768, 1050, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          throw Error("Overflow " + route + " " + width);
        if (route === "" && width === 375) {
          await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
          await page.waitForFunction(
            () => !document.querySelector(".header-space").classList.contains("is-scrolled"),
          );
          await page.screenshot({
            path: `output/playwright/chaiui-home-mobile-${theme}.png`,
            animations: "disabled",
          });
          await page.locator(".mobile-menu summary").focus();
          await page.keyboard.press("Enter");
          if (!(await page.locator(".mobile-menu").evaluate((el) => el.open)))
            throw Error("Mobile keyboard navigation");
          await page.keyboard.press("Escape");
          if (await page.locator(".mobile-menu").evaluate((el) => el.open))
            throw Error("Mobile menu escape");
          await page.locator(".mobile-menu summary").click();
          await page.locator('.mobile-menu a[href="#faq"]').click();
          if (await page.locator(".mobile-menu").evaluate((el) => el.open))
            throw Error("Mobile menu should close after navigation");
        }
      }
    }
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator(".hero-wheel").click();
    if (!(await page.locator(".sy-tour").isVisible())) throw Error("Tour in " + theme);
    await page.locator(".sy-tour .sy-close").hover();
    if (
      await page.locator(".sy-tour .sy-close").evaluate((el) => {
        const style = getComputedStyle(el);
        return style.color === style.backgroundColor;
      })
    )
      throw Error("Close button hover contrast in " + theme);
    await page.mouse.move(0, 0);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState === "finished"),
    );
    await page.screenshot({
      path: `output/playwright/chaiui-tour-${theme}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.locator("#usage a.shot").click();
    if (!(await page.locator(".sy-image-dialog").isVisible())) throw Error("Zoom in " + theme);
    await page.keyboard.press("Escape");
    await page.goto(base, { waitUntil: "networkidle" });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator("#usage").scrollIntoViewIfNeeded();
  if (await page.evaluate(() => document.getAnimations().length))
    throw Error("Reduced motion ignored");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(base);
  if (errors.length) throw Error(errors.join("; "));
  return "Both themes, persistence, four routes at five widths, transparent/scrolled nav, mobile keyboard navigation, eight wheel guides, keyboard FAQs, zoom, screenshot layout, reduced motion and console checks pass.";
}
