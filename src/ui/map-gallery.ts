import { mapProblems } from "./map-check";
import { MAP_CORPUS, type MapShape } from "./map-corpus";
import { layoutMap, MAP_WIDTH, type MapLayout } from "./map-derive";
import { canvasMeasure, lightMapLinks, mapHtml, mapListHtml } from "./map-dom";
import { esc } from "./html";

// The map gallery: every corpus shape drawn through the real layout and renderer, in the dark and
// the light appearance, each pane marked pass or fail by the layout's invariants (with real text
// widths) and by what the browser actually drew. Built by scripts/map-gallery.mjs; never shipped.

// What the browser drew that the layout's numbers can't see: text spilling out of its box, and a
// label or note spilling out of the map.
function drawnProblems(pane: HTMLElement, layout: MapLayout): string[] {
  const out: string[] = [];
  const map = pane.querySelector<HTMLElement>(".map")!.getBoundingClientRect();
  const within = (r: DOMRect, o: DOMRect) =>
    r.left >= o.left - 0.5 &&
    r.right <= o.right + 0.5 &&
    r.top >= o.top - 0.5 &&
    r.bottom <= o.bottom + 0.5;
  for (const box of pane.querySelectorAll<HTMLElement>(".map-box")) {
    const b = box.getBoundingClientRect();
    const inner = new DOMRect(b.left + 8, b.top + 2, b.width - 16, b.height - 4);
    for (const line of box.querySelectorAll("span > span"))
      if (!within(line.getBoundingClientRect(), inner))
        out.push(`drawn: text of ${box.dataset.group} spills out of its box`);
  }
  for (const el of pane.querySelectorAll<HTMLElement | SVGElement>(".map-label, .map-note"))
    if (!within(el.getBoundingClientRect(), map))
      out.push(
        `drawn: ${el.classList[0]} ${el.dataset.from}>${el.dataset.to} spills out of the map`,
      );
  if (map.width !== layout.width) out.push("drawn: the map's width is not the layout's");
  return out;
}

function section(shape: MapShape, i: number) {
  const s = document.createElement("section");
  s.className = "mg-shape";
  s.id = `shape-${i + 1}`;
  s.innerHTML = `<h2>${i + 1}. ${esc(shape.name)}</h2><p>${esc(shape.about)} ${shape.width ? `Laid out for ${shape.width} px.` : ""}</p>`;
  const panes = document.createElement("div");
  panes.className = "mg-panes";
  for (const scheme of ["dark", "light"]) {
    const pane = document.createElement("div");
    pane.className = "mg-pane";
    pane.dataset.scheme = scheme;
    panes.append(pane);
  }
  s.append(panes);
  return s;
}

function draw(sections: HTMLElement[]) {
  const measure = canvasMeasure();
  let failing = 0;
  MAP_CORPUS.forEach((shape, i) => {
    const layout = layoutMap(shape.stages, shape.links, measure, shape.width ?? MAP_WIDTH);
    for (const pane of sections[i]!.querySelectorAll<HTMLElement>(".mg-pane")) {
      const scheme = pane.dataset.scheme!;
      if (!layout) {
        pane.innerHTML = `<div class="mg-badge mg-pass">${scheme} · pass</div><div class="mg-none">No map: fewer than three groups. Narrow list:</div>${mapListHtml(shape.stages, shape.links)}`;
        continue;
      }
      pane.innerHTML = `<div class="mg-badge"></div><div class="mg-scroll">${mapHtml(layout)}</div><ul class="mg-problems"></ul><details><summary>Narrow window list</summary>${mapListHtml(shape.stages, shape.links)}</details>`;
      const problems = [
        ...mapProblems(layout, shape.links, measure),
        ...drawnProblems(pane, layout),
      ];
      const badge = pane.querySelector<HTMLElement>(".mg-badge")!;
      badge.classList.add(problems.length ? "mg-fail" : "mg-pass");
      badge.textContent = `${scheme} · ${problems.length ? `FAIL · ${problems.length}` : "pass"}`;
      pane.querySelector("ul")!.innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join("");
      if (problems.length) failing++;
    }
  });
  const sum = document.querySelector<HTMLElement>(".mg-summary")!;
  sum.className = `mg-summary ${failing ? "mg-fail" : "mg-pass"}`;
  sum.textContent = failing
    ? `${failing} of ${MAP_CORPUS.length * 2} panes fail`
    : `All ${MAP_CORPUS.length} shapes pass in both appearances`;
}

const page = document.createElement("main");
page.className = "mg-page";
page.innerHTML = `<h1>Map gallery</h1><p>Every shape in <code>src/ui/map-corpus.ts</code> through the Overview's layout and renderer, dark and light side by side where the window has room. Point at a box to light its links.</p><div class="mg-summary"></div><nav>${MAP_CORPUS.map((s, i) => `<a href="#shape-${i + 1}">${i + 1}. ${esc(s.name)}</a>`).join("")}</nav>`;
const sections = MAP_CORPUS.map(section);
page.append(...sections);
document.body.append(page);
page.addEventListener("mouseover", (e) => {
  const pane = (e.target as Element).closest<HTMLElement>(".mg-pane");
  const box = (e.target as Element).closest<HTMLElement>(".map-box");
  if (pane) lightMapLinks(pane, box?.dataset.group ?? null);
});
draw(sections);
// Text widths are measured, so lay out again once the font is in.
void document.fonts.ready.then(() => draw(sections));
