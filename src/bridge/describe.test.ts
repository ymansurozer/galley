import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { describeElement, labelOf, targetOf } from "./describe";

function page(html: string) {
  const { document } = new Window();
  document.body.innerHTML = html;
  return (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`fixture has no ${sel}`);
    return el as unknown as Element;
  };
}

test("an element is described by its selector, role, name, text, attributes and surroundings", () => {
  const $ = page(`
    <nav aria-label="Main"><a href="/home">Home</a></nav>
    <main>
      <section aria-labelledby="files-h"><h2 id="files-h">Files</h2>
        <p>Intro</p>
        <h3>Toolbar</h3>
        <button data-testid="upload" type="button" class="upload-button css-1x2y3z">
          <svg><path d="M0 0"></path></svg> Upload   file
        </button>
      </section>
    </main>`);
  const el = describeElement($("button"));
  assert.equal(el.selector, 'button[data-testid="upload"]');
  assert.equal(el.tag, "button");
  assert.equal(el.role, "button");
  assert.equal(el.name, "Upload file");
  assert.equal(el.text, "Upload file");
  assert.deepEqual(el.attrs, { "data-testid": "upload", type: "button" });
  assert.equal(el.landmark, 'region "Files"');
  assert.equal(el.heading, "Toolbar");
  assert.deepEqual(el.rect, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(
    el.outline,
    '<button class="upload-button css-1x2y3z" data-testid="upload" type="button"><svg>…</svg>Upload file</button>',
  );
  assert.equal(describeElement($("nav a")).landmark, 'navigation "Main"');
});

test("form fields are named by their label and never carry what was typed", () => {
  const $ = page(`
    <form><label for="r">Receipt number</label><input id="r" value="IOE0912345678">
    <input type="password" placeholder="Password" value="hunter2"></form>`);
  const receipt = describeElement($("#r"));
  assert.equal(receipt.role, "textbox");
  assert.equal(receipt.name, "Receipt number");
  assert.equal(receipt.text, undefined);
  assert.equal(receipt.landmark, "form");
  const password = describeElement($("[type=password]"));
  assert.equal(password.name, "Password");
  assert.ok(!JSON.stringify(password).includes("hunter2"), "typed values stay out");
  assert.ok(!JSON.stringify(receipt).includes("IOE0912345678"), "typed values stay out");
});

test("page text is capped: text 300, name 200, attributes 200, outline 2 KB", () => {
  const long = "word ".repeat(400);
  const $ = page(`
    <div title="${"t".repeat(500)}" data-testid="${"d".repeat(500)}">
      ${Array.from({ length: 30 }, () => `<p>${long}</p>`).join("")}
    </div>
    <button aria-label="${"n".repeat(500)}">x</button>`);
  const div = describeElement($("div"));
  assert.equal(div.text!.length, 300);
  assert.ok(div.text!.endsWith("…"));
  assert.ok(Object.values(div.attrs!).every((v) => v.length <= 200));
  assert.ok(div.outline!.length <= 2048);
  assert.equal(describeElement($("button")).name!.length, 200);
});

test("a click inside a control picks the control; on an icon, the icon's owner", () => {
  const $ = page(`
    <button id="b"><span class="label">Save</span></button>
    <div id="d"><svg><path id="p" d="M0 0"></path></svg></div>
    <p id="t">Plain <b id="bold">text</b></p>`);
  assert.equal(targetOf($(".label")), $("#b"));
  assert.equal(targetOf($("#p")), $("#d"));
  assert.equal(targetOf($("#bold")), $("#bold"));
});

test("the hover label is role and a short name", () => {
  const $ = page(`<a href="/x">Go to the matters list for this client please</a><div>x</div>`);
  assert.deepEqual(labelOf($("a")), {
    role: "link",
    name: "Go to the matters list for this client …",
  });
  assert.deepEqual(labelOf($("div")), { role: "div", name: "" });
});
