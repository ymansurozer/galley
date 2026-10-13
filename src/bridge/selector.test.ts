import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { isWordClass, selectorFor } from "./selector";

function page(html: string) {
  const { document } = new Window();
  document.body.innerHTML = html;
  const $ = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`fixture has no ${sel}`);
    return el as unknown as Element;
  };
  return { document, $ };
}

test("word-like classes name things; hashed, state, variant and utility classes don't", () => {
  for (const cls of ["upload-button", "matter-card__title", "toolbar", "btn--primary", "FileRow"])
    assert.ok(isWordClass(cls), `${cls} is word-like`);
  for (const cls of [
    "css-1x2y3z", // emotion hash
    "sc-AxjAm", // styled-components
    "_abc123", // CSS modules
    "Button_primary__3xYz", // CSS modules with a hash suffix
    "is-active",
    "has-error",
    "tab-active",
    "menu__item--selected",
    "hover:bg-blue-500", // Tailwind variants
    "md:flex",
    "data-[state=open]:rotate-180",
    "w-[200px]",
    "px-4",
    "items-center",
    "flex",
    "text-sm",
    "rounded-lg",
    "x", // too short to mean anything
  ])
    assert.ok(!isWordClass(cls), `${cls} is not word-like`);
});

test("the ladder prefers #id, then identity attributes, then classes, then position", () => {
  const { $ } = page(`
    <button id="save" data-testid="save-btn">Save</button>
    <button data-testid="upload">Upload</button>
    <button aria-label="Close dialog">×</button>
    <button class="css-9x8y7z share-button">Share</button>
    <ul><li>One</li><li>Two</li></ul>`);
  assert.equal(selectorFor($("#save")), "#save");
  assert.equal(selectorFor($("[data-testid=upload]")), 'button[data-testid="upload"]');
  assert.equal(selectorFor($("[aria-label]")), 'button[aria-label="Close dialog"]');
  assert.equal(selectorFor($(".share-button")), "button.share-button");
  assert.equal(selectorFor($("li + li")), "li:nth-of-type(2)");
});

test("generated ids and shared identity values fall through to a rung that is unique", () => {
  const { $ } = page(`
    <div id="v-0-3"><button data-testid="row-action">Edit</button></div>
    <div><button data-testid="row-action" class="edit-button">Edit</button></div>`);
  const first = selectorFor($("#v-0-3 button"));
  assert.ok(!first.includes("v-0-3"), `a generated id is no handle: ${first}`);
  assert.equal(selectorFor($(".edit-button")), "button.edit-button");
});

test("a position path stops once unique, anchored on the nearest ancestor with a handle", () => {
  const rows = `<tr><td>a</td><td><span>x</span></td></tr><tr><td>b</td><td><span>y</span></td></tr>`;
  const { $ } = page(`
    <section data-testid="files"><table><tbody>${rows}</tbody></table></section>
    <section><table><tbody>${rows}</tbody></table></section>
    <section><table><tbody><tr><td><b>z</b></td></tr></tbody></table></section>`);
  assert.equal(
    selectorFor($("[data-testid=files] tr:nth-of-type(2) span")),
    'section[data-testid="files"] > table > tbody > tr:nth-of-type(2) > td:nth-of-type(2) > span',
  );
  assert.equal(selectorFor($("b")), "b", "a lone tag is already unique");
});

test("every selector the ladder produces matches its element and nothing else", () => {
  const { document } = page(`
    <header class="topbar"><nav aria-label="Main"><a href="/a">A</a><a href="/b" class="is-active">B</a></nav></header>
    <main id="content">
      <div class="card css-1abc2"><h2>One</h2><p>Body <b>bold</b></p><button name="go">Go</button></div>
      <div class="card css-3def4"><h2>Two</h2><p>Body <b>bold</b></p><button name="go">Go</button></div>
      <form><input name="q" placeholder="Search"><input name="q2"><select role="listbox"></select></form>
      <svg><path d="M0 0"></path></svg>
    </main>`);
  const all = [...document.body.querySelectorAll("*")] as unknown as Element[];
  assert.ok(all.length > 20);
  for (const el of all) {
    const sel = selectorFor(el);
    const hits = [...document.querySelectorAll(sel)];
    assert.equal(hits.length, 1, `${sel} matches ${hits.length} elements`);
    assert.equal(hits[0], el, `${sel} matches another element`);
    assert.ok(!/css-\d|is-active/.test(sel), `${sel} leans on a hashed or state class`);
  }
});

test("attribute values with quotes and backslashes are escaped, not broken", () => {
  const { document, $ } = page(`<button aria-label='Say "hi" \\ bye'>x</button>`);
  const sel = selectorFor($("button"));
  assert.equal(document.querySelectorAll(sel).length, 1, sel);
});
