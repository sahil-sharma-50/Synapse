import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const root = dirname(fileURLToPath(import.meta.url));
async function build(extra = {}) {
  const output = await mkdtemp(join(tmpdir(), "synapse-site-"));
  const result = spawnSync(process.execPath, [join(root, "build.mjs"), output], {
    env: { ...process.env, SITE_MODE: "preview", SITE_URL: "", ...extra },
    encoding: "utf8",
  });
  return { ...result, output };
}
const routes = ["index.html", "getting-started/index.html", "privacy/index.html", "404.html"];
async function checkLinks(output, prefix = "/") {
  for (const file of routes) {
    const html = await readFile(join(output, file), "utf8");
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, file);
    assert.doesNotMatch(html, /{{[A-Z_]+}}|<form\b|waitlist|Cloudflare|MailerLite/i);
    for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:|data:)/.test(target)) continue;
      const [path, fragment] = target.split("#");
      if (path) assert.ok(path.startsWith(prefix), file + ": wrong base path " + path);
      const relative = path ? path.slice(prefix.length) : file;
      const dest = relative.endsWith("/") || relative === "" ? relative + "index.html" : relative;
      assert.ok((await stat(join(output, dest))).isFile(), target);
      if (fragment)
        assert.ok(
          (await readFile(join(output, dest), "utf8")).includes('id="' + fragment + '"'),
          file + ": missing anchor " + target,
        );
    }
  }
}
test("preview serves all routes, assets and anchors without collecting information", async () => {
  const r = await build();
  assert.equal(r.status, 0, r.stderr);
  await checkLinks(r.output);
  for (const file of routes) assert.match(await readFile(join(r.output, file), "utf8"), /noindex/);
  assert.match(await readFile(join(r.output, "robots.txt"), "utf8"), /Disallow/);
});
test("production supports the GitHub Pages project prefix and metadata", async () => {
  const r = await build({
    SITE_MODE: "production",
    SITE_URL: "https://sahil-sharma-50.github.io/Synapse/",
  });
  assert.equal(r.status, 0, r.stderr);
  await checkLinks(r.output, "/Synapse/");
  const home = await readFile(join(r.output, "index.html"), "utf8");
  assert.doesNotMatch(home, /noindex/);
  assert.match(home, /rel="canonical" href="https:\/\/sahil-sharma-50.github.io\/Synapse\/"/);
  assert.match(await readFile(join(r.output, "sitemap.xml"), "utf8"), /Synapse\/getting-started\//);
  assert.match(await readFile(join(r.output, "404.html"), "utf8"), /noindex/);
  assert.match(
    await readFile(join(r.output, "styles.css"), "utf8"),
    /url\("\.\/assets\/manrope.woff2"\)/,
  );
  await assert.rejects(stat(join(r.output, "designs")));
  await assert.rejects(stat(join(r.output, "assets/daydream.png")));
});
test("production requires a safe HTTPS site URL", async () => {
  for (const SITE_URL of [
    "",
    "http://example.com/",
    "https://user:password@example.com/",
    "https://example.com/?q=1",
    "https://example.com/#fragment",
    "invalid",
  ]) {
    const r = await build({ SITE_MODE: "production", SITE_URL });
    assert.notEqual(r.status, 0, SITE_URL);
    assert.match(r.stderr, /SITE_URL/);
  }
});
test("production also supports a root-domain deployment", async () => {
  const r = await build({ SITE_MODE: "production", SITE_URL: "https://example.com" });
  assert.equal(r.status, 0, r.stderr);
  await checkLinks(r.output);
  assert.match(
    await readFile(join(r.output, "robots.txt"), "utf8"),
    /https:\/\/example.com\/sitemap.xml/,
  );
});
test("screenshots and wheel icons match the app sources", async () => {
  const r = await build();
  assert.equal(r.status, 0, r.stderr);
  for (const file of ["synapse-overview.png", "customization_options.png", "usuage_stats.png"])
    assert.deepEqual(
      await readFile(join(r.output, "assets", file)),
      await readFile(join(root, "../assets", file)),
    );
  const wheel = await readFile(join(root, "../synapse/src/wedges.ts"), "utf8");
  const tour = await readFile(join(r.output, "product-tour.js"), "utf8");
  const icons = [...wheel.matchAll(/icon: "([^"]+)"/g)];
  assert.equal(icons.length, 8);
  for (const [, icon] of icons) assert.ok(tour.includes(JSON.stringify(icon)), "Wheel icon drift");
});
