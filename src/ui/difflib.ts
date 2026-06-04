import { D } from "./store";
import { FileDiff, parseDiffFromFile, diffAcceptRejectHunk } from "@pierre/diffs";

// Now bundled (not CDN): wire the diff lib onto the non-reactive holder at import time.
D.FileDiff = FileDiff;
D.parseDiffFromFile = parseDiffFromFile;
D.diffAcceptRejectHunk = diffAcceptRejectHunk;

export async function loadDiffLib() {}
