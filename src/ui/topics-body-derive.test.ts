import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTopicBody } from "./topics-body-derive";

test("prose and Mermaid source stay in order, with source untouched", () => {
  assert.deepEqual(
    parseTopicBody("Before.\r\n\r\n```mermaid\r\nflowchart LR\r\n A --> B\r\n```\r\nAfter."),
    [
      { kind: "markdown", text: "Before.\r\n\r\n", line: 1 },
      { kind: "mermaid", text: "flowchart LR\r\n A --> B\r\n", line: 3 },
      { kind: "markdown", text: "After.", line: 7 },
    ],
  );
});

test("ordinary fences, including options, stay markdown", () => {
  const body = "```options\n[]\n```\n````text\n```lines\na.ts:1\n```\n````\n";
  assert.deepEqual(parseTopicBody(body), [{ kind: "markdown", text: body, line: 1 }]);
});

test("a top-level lines fence is a block of its own at its source line", () => {
  assert.deepEqual(
    parseTopicBody("Why.\n\n```lines\na.ts:1-4\n```\nAfter.\n\n- ```lines\n  b.ts:2\n  ```\n"),
    [
      { kind: "markdown", text: "Why.\n\n", line: 1 },
      { kind: "lines", text: "a.ts:1-4\n", line: 3 },
      { kind: "markdown", text: "After.\n\n- ```lines\n  b.ts:2\n  ```\n", line: 6 },
    ],
  );
});

test("tilde and unclosed Mermaid fences follow markdown fence rules", () => {
  assert.deepEqual(parseTopicBody("~~~mermaid\nA --> B\n"), [
    { kind: "mermaid", text: "A --> B\n", line: 1 },
  ]);
});
