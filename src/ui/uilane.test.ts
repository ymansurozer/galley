import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

// The real composer, draft lifecycle, saver and bridge receiver run together. Only HTTP and
// the cross-origin app page are simulated, as in appview.test.ts.
test("new UI annotations opt into captures while drafts, replies and Send keep their lifetimes", async () => {
  const bundle = await build({
    stdin: {
      contents:
        'import {S,saver} from "./store"; import {setView,installAppView} from "./appview"; import {pickedInApp,setUiComposerAside,resumeUiComposer,submitUiComposer,screenshotsInFlight,screenshotsSettled,renderUiLane} from "./uilane"; import {closeComposer,openComposer,buildEditor} from "./composer"; import {renderMarkdown} from "./markdown"; window.harness={S,saver,setView,installAppView,pickedInApp,setUiComposerAside,resumeUiComposer,submitUiComposer,screenshotsInFlight,screenshotsSettled,renderUiLane,closeComposer,openComposer,buildEditor,renderMarkdown};',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  const win = new Window({
    url: "http://localhost:41000/",
    settings: { disableIframePageLoading: true },
  });
  try {
    win.document.body.innerHTML =
      '<div id="appFrame"></div><div id="appStage"></div><div id="pinCard"></div><div id="uiComposer"></div>';
    win.eval(bundle.outputFiles[0]!.text);
    const h = (win as any).harness;
    const { S } = h;
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "browser modules reach the expected state");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await until(() => h.renderMarkdown("**ready**").includes("<strong>"));
    S.state = {
      root: "/repo",
      ui: { target: "http://localhost:3000/" },
      files: [],
      changes: [],
      comments: [],
      annotations: [],
      baseDiffHash: "base",
    };
    S.uiProxy = { port: 41001, token: "test" };
    h.setView("ui");
    h.installAppView();
    const frame = win.document.querySelector("iframe")! as any;
    const messages: any[] = [];
    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: (m: any) => messages.push(m) },
    });
    const bridge = (data: any) =>
      win.dispatchEvent(
        new win.MessageEvent("message", {
          origin: "http://localhost:41001",
          source: frame.contentWindow,
          data: { token: "test", ...data },
        }),
      );
    bridge({ type: "ready", route: "/", title: "App" });
    const requests: Array<{ url: string; body: any }> = [];
    let releaseSave: (() => void) | undefined;
    let holdSave = false;
    let failUpload = false;
    win.fetch = (async (url: string, options: any) => {
      requests.push({ url, body: url === "/api/save" ? JSON.parse(options.body) : options?.body });
      if (url === "/api/save" && holdSave) {
        holdSave = false;
        await new Promise<void>((resolve) => (releaseSave = resolve));
      }
      return {
        ok: !(failUpload && url.startsWith("/api/ui-shot")),
        status: 500,
        json: async () => ({ ok: true }),
      };
    }) as any;
    S.ask = () => h.submitUiComposer("question");
    S.requestChange = () => h.submitUiComposer("action");
    const open = () =>
      h.pickedInApp(
        { route: "/", viewport: { width: 1000, height: 700, dpr: 1 } },
        {
          kind: "element",
          elements: [
            { selector: "#action", tag: "button", rect: { x: 10, y: 10, width: 100, height: 20 } },
          ],
        },
      );
    const checkbox = () =>
      win.document.querySelector<HTMLInputElement>('#uiComposer input[type="checkbox"]')!;
    const submit = (kind: "ask" | "req") => {
      const input = win.document.querySelector<HTMLTextAreaElement>("#uiComposer textarea")!;
      input.value = "Please review this";
      input.dispatchEvent(new win.Event("input"));
      win.document.querySelector<HTMLButtonElement>(`#uiComposer .${kind}`)!.click();
      return S.state.annotations.at(-1);
    };
    const toggle = () => checkbox().click();
    const captures = () => messages.filter((m) => m.type === "capture");
    const uploads = () => requests.filter((r) => r.url.startsWith("/api/ui-shot"));
    const replyToCapture = (error?: string) =>
      bridge({
        type: "captured",
        id: captures().at(-1).id,
        ...(error
          ? { error }
          : {
              shot: {
                crop: new win.Blob(["crop"], { type: "image/png" }),
                viewport: new win.Blob(["viewport"], { type: "image/png" }),
                ms: 1,
              },
            }),
      });
    const detail = () => win.document.querySelector("#pinCard .ann-shot")?.textContent;

    open();
    assert.ok(checkbox(), "new annotation has an accessible native checkbox");
    assert.equal(checkbox().closest("label")!.textContent, "Attach screenshot");
    assert.equal(checkbox().checked, false);
    toggle();
    h.setUiComposerAside();
    S.view = "code";
    S.view = "ui";
    h.resumeUiComposer();
    assert.equal(checkbox().checked, true, "the same draft retains its choice across lanes");
    open();
    assert.equal(checkbox().checked, true, "repicking keeps the current draft's choice");
    win.document.querySelector<HTMLButtonElement>("#uiComposer .uc-close")!.click();
    open();
    assert.equal(checkbox().checked, false, "cancel resets the next draft");
    const omitted = submit("ask");
    await h.saver.settled();
    assert.equal(omitted.screenshotCapture, "omitted");
    assert.equal(h.screenshotsInFlight(), false);
    await h.screenshotsSettled(5);
    assert.equal(captures().length, 0);
    assert.equal(uploads().length, 0);
    assert.equal(detail(), "No screenshot");
    assert.ok(
      requests.some(
        (r) => r.url === "/api/save" && r.body.annotations[0].screenshotCapture === "omitted",
      ),
    );
    assert.ok(
      requests.some((r) => r.url === "/api/ask"),
      "opt-out question still reaches the agent",
    );
    open();
    assert.equal(checkbox().checked, false, "unchecked submit resets the next draft");
    const omittedChange = submit("req");
    await h.saver.settled();
    assert.equal(omittedChange.screenshotCapture, "omitted");
    assert.equal(h.screenshotsInFlight(), false);
    assert.equal(captures().length, 0);
    assert.equal(uploads().length, 0);
    open();
    toggle();
    holdSave = true;
    const checked = submit("req");
    assert.equal(checked.screenshotCapture, "requested");
    assert.equal(h.screenshotsInFlight(), true);
    assert.equal(detail(), "capturing…");
    await until(() => captures().length === 1);
    assert.equal(captures()[0].mark.number, 3);
    assert.equal(captures()[0].mark.question, false);
    replyToCapture();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(uploads().length, 0, "upload waits for the annotation save");
    let settled = false;
    const waiting = h.screenshotsSettled(1000).then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, "Send waits while a checked capture is active");
    await h.screenshotsSettled(5); // The existing Send bound can expire without losing the capture.
    assert.equal(h.screenshotsInFlight(), true);
    releaseSave!();
    await waiting;
    assert.equal(uploads().length, 2);
    assert.ok(uploads()[0]!.url.endsWith("&kind=crop"));
    assert.ok(uploads()[1]!.url.endsWith("&kind=viewport"));
    assert.equal(checked.screenshots, true);
    assert.equal(detail(), "Screenshot");
    assert.equal(h.screenshotsInFlight(), false);
    open();
    assert.equal(checkbox().checked, false, "checked submit resets the next draft");
    toggle();
    const failed = submit("ask");
    await until(() => captures().length === 2);
    assert.equal(captures()[1].mark.question, true);
    replyToCapture("Capture refused");
    await h.screenshotsSettled(1000);
    await h.saver.settled();
    assert.equal(failed.screenshotCapture, "failed");
    assert.equal(detail(), "capture failed");
    assert.ok(
      requests.some(
        (r) => r.url === "/api/save" && r.body.annotations.at(-1).screenshotCapture === "failed",
      ),
    );
    open();
    toggle();
    failUpload = true;
    const uploadFailed = submit("req");
    await until(() => captures().length === 3);
    replyToCapture();
    await h.screenshotsSettled(1000);
    await h.saver.settled();
    assert.equal(uploadFailed.screenshotCapture, "failed");
    assert.equal(uploadFailed.screenshots, undefined);
    failUpload = false;
    open();
    toggle();
    const deleted = submit("req");
    await until(() => captures().length === 4);
    S.state.annotations = S.state.annotations.filter((a: any) => a.id !== deleted.id);
    const before = uploads().length;
    replyToCapture("Capture failed after deletion");
    await h.screenshotsSettled(1000);
    assert.equal(uploads().length, before);
    assert.ok(!S.state.annotations.some((a: any) => a.id === deleted.id));
    open();
    toggle();
    const deletedBeforeUpload = submit("req");
    await until(() => captures().length === 5);
    S.state.annotations = S.state.annotations.filter((a: any) => a.id !== deletedBeforeUpload.id);
    replyToCapture();
    await h.screenshotsSettled(1000);
    assert.equal(
      uploads().length,
      before,
      "a successful capture cannot upload a deleted annotation",
    );

    // Reconstituted records have no in-memory capture promises. Only recorded failure is an
    // error; requested alone is interrupted/unknown, and a stored pair always wins.
    for (const [metadata, stored, expected] of [
      [undefined, false, "No screenshot"],
      ["omitted", false, "No screenshot"],
      ["requested", false, "No screenshot"],
      ["failed", false, "capture failed"],
      [undefined, true, "Screenshot"],
      ["failed", true, "Screenshot"],
    ] as const) {
      const a = {
        ...omitted,
        id: "restored",
        screenshotCapture: metadata,
        screenshots: stored || undefined,
      };
      S.state.annotations = [a];
      S.selectedAnnotation = a.id;
      h.renderUiLane();
      assert.equal(detail(), expected);
      assert.equal(h.screenshotsInFlight(), false);
    }
    const beforeReply = captures().length;
    h.openComposer("restored");
    assert.equal(
      win.document.querySelector('#pinCard input[type="checkbox"]'),
      null,
      "replies have no capture control",
    );
    S.composerBody = "A reply without recapturing";
    h.submitUiComposer("action");
    await h.saver.settled();
    assert.equal(captures().length, beforeReply);
    assert.equal(h.screenshotsInFlight(), false);
    h.openComposer("restored", "Edited body", S.state.annotations[0].comments[0].id);
    assert.equal(
      h.buildEditor().querySelector('input[type="checkbox"]'),
      null,
      "edits have no capture control",
    );
    h.closeComposer();
  } finally {
    await win.happyDOM.close();
  }
});
