import { mkdir, readFile, writeFile, copyFile, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] || join(root, "dist"));
const production = process.env.SITE_MODE === "production";
const escape = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
let site;
if (process.env.SITE_URL) {
  try {
    site = new URL(process.env.SITE_URL);
  } catch {
    throw new Error("Invalid SITE_URL: use an absolute HTTPS site URL.");
  }
  if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash)
    throw new Error("Invalid SITE_URL: HTTPS only, without credentials, query, or fragment.");
  site.pathname = site.pathname.replace(/\/$/, "") + "/";
}
if (production && !site) throw new Error("SITE_URL is required for production.");
const prefix = site?.pathname || "/";
const localPaths = (html) => html.replace(/(href|src)="\/(?!\/)/g, '$1="' + prefix);
const home = await readFile(join(root, "src/index.html"), "utf8");
const head = home.match(/<head>([\s\S]*?)<\/head>/)[1];
const header = home.match(/<div class="header-space">[\s\S]*?(?=\s*<div id="home">)/)[0];
const footer = home.match(/<footer[\s\S]*?<\/footer>/)[0];
const homeLinks = (html) => html.replace(/href="#/g, 'href="/#');
const pages = [
  [
    "index.html",
    "",
    "Synapse | Everyday tools, one shortcut away",
    "Local dictation, AI, notes and clipboard tools. One shortcut away on Windows.",
  ],
  [
    "getting-started/index.html",
    "getting-started/",
    "Getting started | Synapse",
    "Install Synapse on Windows, configure shortcuts, set up local speech and connect your AI provider.",
  ],
  [
    "privacy/index.html",
    "privacy/",
    "Privacy | Synapse",
    "How this Synapse website is hosted and what information it handles.",
  ],
  ["404.html", "404.html", "Page not found | Synapse", "Find your way back to Synapse."],
];
for (const [file, route, title, description] of pages) {
  let html;
  if (file === "index.html") html = home;
  else {
    const content = await readFile(join(root, "src", file), "utf8");
    const pageHead = head.replace(/\s*<script src="\/product-tour.js" defer><\/script>/, "");
    html =
      '<!doctype html><html lang="en"><head>' +
      pageHead +
      '</head><body><a class="skip-link" href="#main">Skip to content</a>' +
      homeLinks(header) +
      content +
      homeLinks(footer) +
      "</body></html>";
  }
  html = html.replace(/<title>[\s\S]*?<\/title>/, "<title>" + escape(title) + "</title>");
  html = html.replace(/\s*<meta name="robots"[^>]*>/g, "");
  const canonical = site ? new URL(route, site).href : "";
  const metadata =
    '<meta name="description" content="' +
    escape(description) +
    '">' +
    (!production || file === "404.html" ? '<meta name="robots" content="noindex, nofollow">' : "") +
    (canonical && file !== "404.html"
      ? '<link rel="canonical" href="' +
        escape(canonical) +
        '"><meta property="og:url" content="' +
        escape(canonical) +
        '">'
      : "") +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="Synapse"><meta property="og:title" content="' +
    escape(title) +
    '"><meta property="og:description" content="' +
    escape(description) +
    '">' +
    (site
      ? '<meta property="og:image" content="' +
        escape(new URL("assets/synapse-overview.png", site).href) +
        '">'
      : "") +
    '<meta name="twitter:card" content="summary_large_image"><link rel="icon" type="image/png" href="/assets/synapse-icon.png">';
  html = localPaths(html.replace("</head>", metadata + "</head>"));
  await mkdir(dirname(join(output, file)), { recursive: true });
  await writeFile(join(output, file), html);
}
for (const file of ["styles.css", "site.js", "product-tour.css", "product-tour.js"])
  await copyFile(join(root, "src", file), join(output, file));
await mkdir(join(output, "assets"), { recursive: true });
const assets = [
  "manrope.woff2",
  "Manrope-LICENSE.txt",
  "synapse-icon.png",
  "synapse-overview.png",
  "customization_options.png",
  "usuage_stats.png",
];
for (const file of assets)
  await copyFile(join(root, "src/assets", file), join(output, "assets", file));
// Concept alternatives are local review material, excluded from the published artifact.
if (!production && existsSync(join(root, "src/designs"))) {
  await cp(join(root, "src/designs"), join(output, "designs"), { recursive: true });
  await cp(join(root, "src/assets"), join(output, "assets"), { recursive: true });
}
await writeFile(join(output, ".nojekyll"), "");
await writeFile(
  join(output, "robots.txt"),
  production
    ? "User-agent: *\nAllow: /\nSitemap: " + new URL("sitemap.xml", site).href + "\n"
    : "User-agent: *\nDisallow: /\n",
);
await writeFile(
  join(output, "sitemap.xml"),
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    (production
      ? pages
          .filter(([file]) => file !== "404.html")
          .map(([, route]) => "<url><loc>" + escape(new URL(route, site).href) + "</loc></url>")
          .join("")
      : "") +
    "</urlset>",
);
console.log("Built " + (production ? "production" : "preview") + " site at " + output);
