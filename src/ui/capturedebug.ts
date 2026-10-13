import { captureApp } from "./appview";
import type { UiMarkTarget } from "./types";

// Dev-only screenshot check, on only when the desk URL carries ?debug=capture: a Capture button in
// the chrome bar and `galleyDebug.capture(selector?)` in the console screenshot the app page through
// the bridge and show the viewport image and the crop in a modal, with their timings. Nothing is
// stored. The console call resolves with the shot, so a script can read the PNGs back.

export function installCaptureDebug() {
  if (new URLSearchParams(location.search).get("debug") !== "capture") return;

  const backdrop = el("div", "modal-backdrop");
  backdrop.innerHTML = `
    <div class="modal" style="width:min(1280px,94vw);max-height:92vh;overflow:auto">
      <h3>Capture (debug)</h3>
      <form style="display:flex;gap:6px;margin:8px 0">
        <input name="sel" placeholder="Crop selector ending in a tag, e.g. main table" spellcheck="false"
          style="flex:1;font-family:var(--mono)">
        <button class="btn primary">Capture</button>
        <button class="btn" type="button" data-close>Close</button>
      </form>
      <p data-status></p>
      <div style="display:grid;gap:12px;margin-top:10px;justify-items:start">
        <figure style="margin:0"><img data-crop style="max-width:100%;border:1px solid var(--line)"><figcaption data-crop-cap></figcaption></figure>
        <figure style="margin:0"><img data-viewport style="max-width:100%;border:1px solid var(--line)"><figcaption data-viewport-cap></figcaption></figure>
      </div>
    </div>`;
  document.body.append(backdrop);
  const q = <T extends HTMLElement>(sel: string, type: new () => T) => {
    const node = backdrop.querySelector(sel);
    if (!(node instanceof type)) throw new Error(`capture debug: ${sel} missing`);
    return node;
  };
  const form = q("form", HTMLFormElement);
  const input = q("input", HTMLInputElement);
  const status = q("[data-status]", HTMLElement);
  const images = {
    crop: q("[data-crop]", HTMLImageElement),
    viewport: q("[data-viewport]", HTMLImageElement),
  };
  const captions = {
    crop: q("[data-crop-cap]", HTMLElement),
    viewport: q("[data-viewport-cap]", HTMLElement),
  };

  // Only the latest capture's reply reaches the modal (an earlier one still resolves its console
  // call), and closing the modal drops any in flight, so no image URL outlives what's on screen.
  let latest = 0;
  const clear = () => {
    for (const img of Object.values(images)) {
      if (img.src) URL.revokeObjectURL(img.src);
      img.removeAttribute("src");
    }
    for (const cap of Object.values(captions)) cap.textContent = "";
  };
  const close = () => {
    latest++;
    backdrop.classList.remove("show");
    clear();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || (e.target instanceof Element && e.target.closest("[data-close]")))
      close();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    capture(input.value.trim() || undefined).catch(() => {}); // the status line shows the failure
  });

  async function capture(selector?: string) {
    const seq = ++latest;
    backdrop.classList.add("show");
    input.value = selector ?? "";
    status.textContent = "Capturing…";
    clear();
    const t0 = performance.now();
    try {
      const shot = await captureApp(selector ? { target: cropTarget(selector) } : {});
      const roundTrip = Math.round(performance.now() - t0);
      if (seq === latest) {
        status.textContent = `Rendered in the page in ${shot.ms} ms · ${roundTrip} ms round trip`;
        show("viewport", shot.viewport);
        if (shot.crop) show("crop", shot.crop);
        else
          captions.crop.textContent = selector
            ? "No crop: nothing on screen matches"
            : "No crop selector";
      }
      return { ...shot, roundTrip };
    } catch (err) {
      if (seq === latest)
        status.textContent = `Capture failed: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  }

  function show(which: "crop" | "viewport", png: Blob) {
    const img = images[which];
    if (img.src) URL.revokeObjectURL(img.src);
    img.onload = () => {
      // At the page's CSS size: the PNG is rendered at devicePixelRatio, the same as the desk's.
      img.style.width = `${img.naturalWidth / devicePixelRatio}px`;
      captions[which].textContent =
        `${which} · ${img.naturalWidth} × ${img.naturalHeight} px · ${Math.round(png.size / 1024)} KB`;
    };
    img.src = URL.createObjectURL(png);
  }

  const button = el("button", "sq");
  button.textContent = "Capture";
  button.title = "Capture the app page (debug)";
  button.style.cssText = "width:auto;padding:0 8px;font-size:var(--text-2xs)";
  button.addEventListener("click", () => capture(input.value.trim() || undefined).catch(() => {}));
  document.querySelector(".uiview .chrome .vpsize")?.before(button);

  Object.assign(window, { galleyDebug: { capture } });
}

// The crop's element, found as a mark's would be: by the selector, which names its tag last
// (`main table`, `button.primary`), with nothing to check it against.
function cropTarget(selector: string): UiMarkTarget {
  const tag = selector.match(/(?:^|[\s>+~])([a-z][\w-]*)[^\s>+~]*$/i)?.[1]?.toLowerCase() ?? "";
  return {
    kind: "element",
    elements: [{ selector, tag, rect: { x: 0, y: 0, width: 0, height: 0 } }],
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
