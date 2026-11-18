// Checks a running desk in headless Chromium: the tab loads, every file the desk serves has its own
// tree row, clicking it opens that file and renders its changed lines (or a pure rename's notice),
// and nothing throws. Prints one JSON line, or exits non-zero with the reason. Point it at `pnpm desk:sandbox`, not a desk on the real HOME.
// Run: pnpm desk:browse <url> [--screenshot <file.png>]
// Chromium comes from Playwright's cache under the real HOME (~/.cache/ms-playwright, or
// ~/Library/Caches/ms-playwright on macOS) at the revision the pinned playwright-core expects;
// `pnpm exec playwright-core install chromium` fetches it when it's missing.
import { chromium } from "playwright-core";

const RENDER_MS = 20_000;
const STATE_MS = 10_000;

function parseArgs(argv) {
  const out = { url: undefined, screenshot: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--screenshot") out.screenshot = argv[++i];
    else if (!out.url) out.url = argv[i];
  }
  return out;
}

const fail = (message) => {
  console.error(`desk:browse: ${message}`);
  process.exit(1);
};

const { url, screenshot } = parseArgs(process.argv.slice(2));
if (!url) fail("usage: pnpm desk:browse <desk url> [--screenshot <file.png>]");
const base = url.replace(/\/+$/, "");

// The files the tree must show come from the desk itself, so the check holds for any fixture.
let expected;
try {
  const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(STATE_MS) });
  if (!res.ok) throw new Error(`/api/state answered ${res.status}`);
  expected = (await res.json()).files;
} catch (error) {
  fail(
    `no desk answers at ${base} (${error instanceof Error ? error.message : error}). ` +
      "Start one with `pnpm desk:sandbox` and pass the url it prints.",
  );
}
if (!expected.length) fail(`the desk at ${base} has no changes to review; nothing would render`);

let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist/.test(message))
    fail(
      `Chromium for playwright-core isn't installed at ${chromium.executablePath()}. ` +
        "Run `pnpm exec playwright-core install chromium` with your real HOME.",
    );
  fail(`Chromium failed to launch: ${message}`);
}
const close = () => browser?.close().finally(() => process.exit(1));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, close);

const consoleErrors = [];
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(url);

  const step = async (what, wait) => {
    try {
      await wait();
    } catch {
      const errors = pageErrors.length ? ` Page errors: ${pageErrors.join(" | ")}` : "";
      throw new Error(`${what} within ${RENDER_MS / 1000}s.${errors}`);
    }
  };
  await step("the file tree never rendered", () =>
    page.locator("#files .node").first().waitFor({ timeout: RENDER_MS }),
  );
  // Pure renames and other skimmed files sit in a collapsed group; open it so every file has a row.
  const skimmed = page.locator("#files .node.skimgrp");
  if (await skimmed.count()) await skimmed.click();

  // Each served file needs its own row (keyed by path, as src/ui/tree.ts keys it), and clicking it
  // must open that file: the bar names its full path, and the view under it is the file's rendered
  // changes. The contents error card has a bar too, so it counts as a failure, not a render.
  const views = [];
  for (const file of expected) {
    const row = page.locator(
      ["file", "test"]
        .map((kind) => `#files .node[data-key=${JSON.stringify(`${kind}:${file.path}`)}]`)
        .join(", "),
    );
    if ((await row.count()) !== 1)
      throw new Error(`the file tree has no row for ${file.path}, which /api/state serves`);
    await row.click();
    let view;
    try {
      view = await page
        .waitForFunction(
          ({ path, renamed, oversized }) => {
            const diff = document.querySelector("#diff");
            if (diff?.querySelector(".fb-path")?.getAttribute("title") !== path) return false;
            if (diff.querySelector(".contents-error")) return "contents-error";
            if (oversized && diff.querySelector(".oversized-card")) return "oversized";
            const moved = diff.querySelector(".file-skim-strip.moved");
            if (
              renamed &&
              moved &&
              [...moved.querySelectorAll(".file-skim-name")].some((n) => n.textContent === path)
            )
              return "pure-rename";
            for (const el of diff.querySelectorAll("*"))
              if (el.shadowRoot?.querySelector("[data-line-type^='change-']")) return "diff";
            return false;
          },
          {
            path: file.path,
            renamed: file.changeKind === "renamed",
            oversized: file.oversized === true,
          },
          { timeout: RENDER_MS },
        )
        .then((h) => h.jsonValue());
    } catch {
      const shown = await page.evaluate(() => {
        const diff = document.querySelector("#diff");
        const bar = diff?.querySelector(".fb-path")?.getAttribute("title");
        return `${bar ?? "no file"}: ${(diff?.textContent ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
      });
      const errors = pageErrors.length ? ` Page errors: ${pageErrors.join(" | ")}` : "";
      throw new Error(
        `${file.path} never rendered within ${RENDER_MS / 1000}s; the diff pane shows ${shown}.${errors}`,
      );
    }
    if (view === "contents-error")
      throw new Error(
        `the desk couldn't load ${file.path}'s contents (the pane shows its error card); ` +
          "check /api/file-contents for that path",
      );
    views.push({ path: file.path, view });
  }
  if (screenshot) await page.screenshot({ path: screenshot });
  if (pageErrors.length) throw new Error(`the page threw: ${pageErrors.join(" | ")}`);

  console.log(
    JSON.stringify({
      ok: true,
      url,
      title: await page.title(),
      chromium: browser.version(),
      files: views,
      consoleErrors,
      screenshot,
    }),
  );
} catch (error) {
  console.error(`desk:browse: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
