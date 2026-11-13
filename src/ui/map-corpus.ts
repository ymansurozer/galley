import type { GuideLink } from "../types";
import { linkKey, type MapStage } from "./map-derive";

// The shapes of change the map is held to: guide stages, groups and links alone, made-up content.
// map-derive.test.ts checks the layout's invariants over every shape, and the gallery
// (scripts/map-gallery.mjs) draws each one for a person to look at. Not part of the desk's bundle.

export type MapShape = {
  name: string;
  // What the shape stresses.
  about: string;
  stages: MapStage[];
  links: GuideLink[];
  // The width the map is laid out for, when not the Overview's widest.
  width?: number;
  // Invariant breaks this shape is known to keep, each with the reason it cannot be helped. The
  // corpus test holds the shape to exactly these, so a new break, or one fixed, shows.
  known?: { problems: string[]; why: string };
};

type G = [id: string, title: string, summary?: string];

function shape(
  name: string,
  about: string,
  stages: Array<[label: string, groups: G[]]>,
  links: Array<[from: string, to: string, label: string]> = [],
  width?: number,
): MapShape {
  const s: MapShape = {
    name,
    about,
    stages: stages.map(([label, groups], i) => ({
      id: `s${i + 1}`,
      label,
      groups: groups.map(([id, title, summary]) =>
        summary ? { id, title, summary } : { id, title },
      ),
    })),
    links: links.map(([from, to, label]) => ({ from, to, label })),
  };
  if (width) s.width = width;
  return s;
}

const control = shape(
  "control",
  "Ten groups in five stages, nine links: the shape the map was built on.",
  [
    [
      "Sources",
      [
        ["catalog", "Catalog import", "Entries come from the publisher feed, split into sections."],
        [
          "backfill",
          "Archive backfill",
          "Older records are parsed once and stored with their source.",
        ],
        ["forum", "Forum digests", "Threads and weekly digests, cleaned of signatures."],
        ["helpdesk", "Helpdesk pairs", "Each answered request is kept with its reply."],
      ],
    ],
    [
      "Index and search",
      [["search", "Search", "One index and one ranking path for every source."]],
    ],
    [
      "Tools",
      [
        ["rules", "Rules lookup", "Finds the rule that applies and quotes it."],
        ["howto", "How-to answers", "Answers from past replies, with the reply linked."],
        ["access", "Who sees what", "A guide is shown only to the teams it was written for."],
      ],
    ],
    ["In the app", [["reader", "Reader", "Answers open beside the source they cite."]]],
    ["Shipping it", [["rollout", "Rollout", "Behind a flag, team by team."]]],
  ],
  [
    ["catalog", "search", "catalog entries"],
    ["backfill", "search", "archive records, parsed files"],
    ["forum", "search", "threads, digests"],
    ["helpdesk", "howto", "request and reply pairs"],
    ["search", "rules", "one search path"],
    ["search", "howto", "one search path"],
    ["access", "howto", "who reaches a guide"],
    ["rules", "reader", "citations"],
    ["howto", "reader", "citations"],
  ],
);

export const MAP_CORPUS: MapShape[] = [
  control,
  shape(
    "small fix",
    "Two groups, one link: nothing to map.",
    [
      ["Server", [["save", "Save on stop", "Stopping writes the state first."]]],
      ["Browser", [["tab", "Second tab", "A second tab reads the saved state."]]],
    ],
    [["save", "tab", "saved state"]],
  ),
  shape(
    "no links",
    "Seven groups in three areas; nothing feeds anything, so the map is an index.",
    [
      [
        "Server",
        [
          ["locks", "Lock files", "A lock is trusted only when its server answers."],
          ["ports", "Port range", "The range is read once and passed down."],
        ],
      ],
      [
        "Browser",
        [
          ["caps", "Key hints", "Shortcuts are drawn by one helper."],
          ["light", "Light palette", "The light colours move into the token layer."],
          ["tree", "File tree", "Folders with one child fold into one row."],
        ],
      ],
      [
        "Release",
        [
          ["docs", "Contract text", "The docs say what each event carries."],
          ["notes", "Release notes", "Notes are grouped by kind of change."],
        ],
      ],
    ],
  ),
  shape(
    "hub and spoke",
    "One layer six others take three things from; six rows, so titles only, and a fan.",
    [
      ["Tokens", [["tokens", "Design tokens", "Every colour, size and radius gets a name."]]],
      [
        "Sheets",
        [
          ["frame", "Frame"],
          ["sidebar", "Sidebar"],
          ["header", "Header"],
          ["threads", "Threads"],
          ["home", "Home page"],
          ["dialogs", "Dialogs"],
        ],
      ],
      ["Checks", [["shots", "Screenshot check", "Both themes are shot and compared."]]],
    ],
    [
      ["tokens", "frame", "colours"],
      ["tokens", "sidebar", "colours"],
      ["tokens", "header", "type scale"],
      ["tokens", "home", "type scale"],
      ["tokens", "threads", "radii"],
      ["tokens", "dialogs", "radii"],
      ["threads", "shots", "light and dark"],
      ["dialogs", "shots", "light and dark"],
    ],
  ),
  shape(
    "wide and deep",
    "Thirteen groups in five stages, twelve links; links skip stages and cross boxes.",
    [
      [
        "Contract",
        [
          ["types", "Wire types", "Shapes shared by both sides."],
          ["docs", "Agent docs", "The contract text."],
        ],
      ],
      [
        "Server",
        [
          ["validate", "Validation", "A bad input is refused."],
          ["state", "State", "What survives a restart."],
          ["api", "HTTP API", "The poll and one new route."],
          ["cli", "Commands", "Two new subcommands."],
        ],
      ],
      [
        "Browser",
        [
          ["store", "Store and poll", "Holds what the views read."],
          ["home", "Home page", "The way in."],
          ["page", "Detail page", "One item and its parts."],
          ["side", "Sidebar", "Items under their headings."],
        ],
      ],
      ["Agent side", [["skill", "Agent notes", "Point agents at the docs."]]],
      [
        "Checks",
        [
          ["smoke", "End-to-end run", "The contract, start to finish."],
          ["doctest", "Docs tests", "The docs and the code agree."],
        ],
      ],
    ],
    [
      ["types", "validate", "input shapes"],
      ["types", "store", "type-only import"],
      ["docs", "skill", "contract text"],
      ["docs", "doctest", "contract text"],
      ["validate", "state", "accepted input"],
      ["state", "api", "saved state"],
      ["cli", "api", "await, reply"],
      ["api", "store", "state poll"],
      ["store", "home", "map, totals"],
      ["store", "page", "one item"],
      ["store", "side", "counts"],
      ["api", "smoke", "agent contract"],
    ],
  ),
  shape(
    "loop",
    "Six groups in three stages; two links run back to the start and become notes.",
    [
      [
        "Writer",
        [
          ["edits", "Edits the draft", "Applies requested changes."],
          ["outline", "Writes the outline", "A new outline, old ids kept."],
        ],
      ],
      [
        "Desk",
        [
          ["reload", "Reload", "Re-reads the draft into the open tab."],
          ["carry", "Carry over", "Marks stay unless the text changed."],
        ],
      ],
      [
        "Reader",
        [
          ["mark", "Marks sections", "Approves, asks or requests a change."],
          ["send", "Sends notes", "Everything held goes at once."],
        ],
      ],
    ],
    [
      ["edits", "reload", "new draft"],
      ["outline", "reload", "outline and its hash"],
      ["reload", "carry", "content hashes"],
      ["carry", "mark", "what is still open"],
      ["mark", "send", "sign-offs"],
      ["send", "edits", "change requests"],
      ["send", "outline", "questions"],
    ],
  ),
  shape(
    "seven stages",
    "Nine groups in seven stages, eight links: wider than the page.",
    [
      ["Read", [["read", "File reader"]]],
      ["Parse", [["parse", "Record parser"]]],
      [
        "Split",
        [
          ["split", "Record splitter"],
          ["dupes", "Duplicate finder"],
        ],
      ],
      ["Keys", [["keys", "Stable keys and hashes"]]],
      [
        "Match",
        [
          ["match", "Record matching"],
          ["anchors", "Note re-anchoring"],
        ],
      ],
      ["Store", [["store", "State file"]]],
      ["Serve", [["serve", "State poll"]]],
    ],
    [
      ["read", "parse", "raw bytes"],
      ["parse", "split", "records"],
      ["parse", "dupes", "records"],
      ["split", "keys", "chunks"],
      ["keys", "match", "key and hash"],
      ["keys", "anchors", "anchor text"],
      ["match", "store", "matches"],
      ["store", "serve", "saved state"],
    ],
  ),
  shape(
    "dense",
    "Nine groups in three stages, twelve links each with its own label.",
    [
      [
        "Server",
        [
          ["core", "State core", "Records, hashes and merge."],
          ["http", "HTTP server", "The API and the long poll."],
          ["proxy", "Page proxy", "A second listener that frames the app."],
        ],
      ],
      [
        "Browser",
        [
          ["store", "Store", "One store the views read."],
          ["render", "Renderer", "Lines, gutters and notes."],
          ["tour", "Tour view", "The walkthrough over the list."],
        ],
      ],
      [
        "Embedded",
        [
          ["inject", "Script inject", "What every framed page gets."],
          ["pick", "Element pick", "Click an element to comment on it."],
          ["msg", "Messages", "Tokened messages to the desk."],
        ],
      ],
    ],
    [
      ["core", "store", "records"],
      ["core", "render", "blocks"],
      ["core", "tour", "tour hash"],
      ["http", "store", "state poll"],
      ["http", "tour", "tour route"],
      ["http", "render", "raw lines"],
      ["proxy", "inject", "every page"],
      ["proxy", "pick", "origin"],
      ["store", "pick", "pick mode"],
      ["store", "msg", "token"],
      ["render", "msg", "anchors"],
      ["tour", "inject", "tour step"],
    ],
  ),
  shape(
    "long titles",
    "Titles and summaries far longer than a box is wide.",
    [
      [
        "Intake",
        [
          [
            "intake",
            "Incoming requests are validated, normalised and queued before anything else sees them",
            "Every request is checked against the schema, its dates turned into one zone, and the result queued with a retry budget.",
          ],
          [
            "limits",
            "Per-account rate limits with a separate allowance for scheduled background jobs",
            "Interactive and background work no longer share one bucket.",
          ],
        ],
      ],
      [
        "Processing",
        [
          [
            "worker",
            "A worker pool that drains the queue in priority order and backs off on repeated failures",
            "Workers take the oldest high-priority item first; three failures in a row park the item for a person.",
          ],
        ],
      ],
      [
        "Output",
        [
          [
            "notify",
            "Notifications sent by email, chat and the in-app inbox, deduplicated per person per hour",
            "One person gets one message an hour, whatever the channel.",
          ],
        ],
      ],
    ],
    [
      ["intake", "worker", "validated, normalised request records"],
      ["limits", "worker", "allowance per account"],
      ["worker", "notify", "finished and failed items"],
    ],
  ),
  shape(
    "labels at the limit",
    "Every label is forty characters, and one box has three exits.",
    [
      [
        "Source",
        [
          ["orders", "Orders", "New and changed orders."],
          ["stock", "Stock", "Counts per warehouse."],
        ],
      ],
      [
        "Rules",
        [
          ["pricing", "Pricing", "Discounts and taxes."],
          ["holds", "Holds", "Orders waiting on stock."],
          ["fraud", "Fraud checks", "Scores and manual review."],
        ],
      ],
      ["Out", [["ledger", "Ledger", "What was charged, and why."]]],
    ],
    [
      ["orders", "pricing", "order lines with the tier and the region"],
      ["orders", "holds", "orders whose items are not yet available"],
      ["orders", "fraud", "payment details and the delivery address"],
      ["stock", "holds", "counts per item per warehouse every hour"],
      ["pricing", "ledger", "final prices, discounts and tax per line"],
      ["fraud", "ledger", "approved orders and the reason for holds"],
    ],
  ),
  shape(
    "one stage",
    "Four groups in a single stage, linked to neighbours and round the side.",
    [
      [
        "Library",
        [
          ["parse", "Parser", "Reads the input."],
          ["check", "Checker", "Finds mistakes."],
          ["fix", "Fixer", "Rewrites what it can."],
          ["print", "Printer", "Writes the output."],
        ],
      ],
    ],
    [
      ["parse", "check", "syntax tree"],
      ["check", "fix", "problems"],
      ["parse", "print", "syntax tree"],
    ],
  ),
  shape(
    "twenty groups",
    "Twenty groups in four stages, eighteen links.",
    [
      [
        "Inputs",
        [
          ["i1", "Sign-up form"],
          ["i2", "Invite links"],
          ["i3", "Single sign-on"],
          ["i4", "Import from file"],
          ["i5", "Admin console"],
        ],
      ],
      [
        "Accounts",
        [
          ["a1", "Profiles"],
          ["a2", "Teams"],
          ["a3", "Roles"],
          ["a4", "Sessions"],
          ["a5", "Audit trail"],
          ["a6", "Deletion"],
        ],
      ],
      [
        "Billing",
        [
          ["b1", "Plans"],
          ["b2", "Seats"],
          ["b3", "Invoices"],
          ["b4", "Tax"],
          ["b5", "Refunds"],
        ],
      ],
      [
        "Reports",
        [
          ["r1", "Usage report"],
          ["r2", "Revenue report"],
          ["r3", "Security report"],
          ["r4", "Export"],
        ],
      ],
    ],
    [
      ["i1", "a1", "new user"],
      ["i2", "a2", "membership"],
      ["i3", "a4", "session"],
      ["i4", "a1", "imported users"],
      ["i5", "a3", "role changes"],
      ["a1", "b2", "seat count"],
      ["a2", "b2", "team size"],
      ["a2", "b1", "team plan"],
      ["a3", "a5", "role events"],
      ["a4", "a5", "sign-ins"],
      ["a6", "b5", "closed accounts"],
      ["b1", "b3", "plan price"],
      ["b2", "b3", "seats"],
      ["b4", "b3", "tax lines"],
      ["b3", "r2", "invoices"],
      ["b5", "r2", "refunds"],
      ["a5", "r3", "audit events"],
      ["r2", "r4", "rows"],
    ],
  ),
  {
    ...shape(
      "crossings in one row",
      "One box sends five links past the same two boxes; past the four strips, the rest fall back inside them.",
      [
        [
          "Events",
          [
            ["bus", "Event bus", "Every change, once."],
            ["clock", "Clock", "Ticks every minute."],
          ],
        ],
        ["Filter", [["filter", "Filter", "Drops noise."]]],
        ["Enrich", [["enrich", "Enrich", "Adds context."]]],
        [
          "Sinks",
          [
            ["search", "Search index"],
            ["mail", "Mail digest"],
            ["hooks", "Webhooks"],
            ["metrics", "Metrics"],
            ["archive", "Archive"],
          ],
        ],
      ],
      [
        ["bus", "filter", "raw events"],
        ["filter", "enrich", "kept events"],
        ["bus", "search", "documents"],
        ["bus", "mail", "mentions"],
        ["bus", "hooks", "subscribed events"],
        ["bus", "metrics", "counters"],
        ["bus", "archive", "everything"],
        ["clock", "search", "reindex"],
        ["clock", "mail", "digest time"],
        ["clock", "hooks", "retries"],
        ["clock", "metrics", "flush"],
        ["clock", "archive", "rotate"],
      ],
    ),
    known: {
      problems: ["search", "hooks", "metrics"].map(
        (to) => `link ${linkKey("bus", to)} crosses 2 boxes and is labelled only at its start`,
      ),
      why: "The gap before the sinks holds ten lanes, two into each sink, and no spot there can be told apart for these three links' labels to be said again; each is said once, clear, at its source.",
    },
  },
  shape(
    "several links back",
    "Four links back to earlier stages, two from one box.",
    [
      [
        "Plan",
        [
          ["brief", "Brief", "What to build."],
          ["spec", "Spec", "How it should behave."],
        ],
      ],
      [
        "Build",
        [
          ["code", "Code", "The change itself."],
          ["tests", "Tests", "What proves it."],
        ],
      ],
      [
        "Review",
        [
          ["review", "Review", "A person reads it."],
          ["ship", "Ship", "Merge and release."],
        ],
      ],
    ],
    [
      ["brief", "spec", "goals"],
      ["spec", "code", "behaviours"],
      ["spec", "tests", "cases"],
      ["code", "review", "diff"],
      ["tests", "review", "results"],
      ["review", "ship", "approval"],
      ["review", "spec", "open questions"],
      ["review", "code", "change requests"],
      ["tests", "spec", "gaps found"],
      ["ship", "brief", "what users said"],
    ],
  ),
  shape(
    "two stages apart",
    "Two stages nothing links to sit apart in the last column.",
    [
      [
        "Server",
        [
          ["api", "API", "Routes and checks."],
          ["jobs", "Jobs", "Background work."],
        ],
      ],
      [
        "Browser",
        [
          ["ui", "Screens", "What people see."],
          ["cache", "Cache", "Kept between visits."],
        ],
      ],
      [
        "Docs",
        [
          ["guide", "User guide", "How to use it."],
          ["faq", "FAQ", "Common questions."],
        ],
      ],
      ["Tooling", [["lint", "Lint rules", "One new rule."]]],
    ],
    [
      ["api", "ui", "responses"],
      ["jobs", "cache", "warm entries"],
    ],
  ),
  shape(
    "single link",
    "Five groups, one link.",
    [
      [
        "Data",
        [
          ["schema", "Schema", "Two new columns."],
          ["migrate", "Migration", "Backfills the columns."],
        ],
      ],
      [
        "App",
        [
          ["form", "Form", "Edits the new fields."],
          ["list", "List", "Shows them."],
          ["search", "Search", "Filters by them."],
        ],
      ],
    ],
    [["schema", "form", "new fields"]],
  ),
  { ...control, name: "narrow window", about: "The control shape in a 720 px window.", width: 720 },
  shape(
    "jog round the side",
    "Links inside a stage that skip a box, in the middle and the last column.",
    [
      ["Input", [["in", "Input", "Where it starts."]]],
      [
        "Middle",
        [
          ["m1", "First step", "Reads it."],
          ["m2", "Second step", "Shapes it."],
          ["m3", "Third step", "Checks it."],
        ],
      ],
      [
        "End",
        [
          ["e1", "Writer", "Saves it."],
          ["e2", "Indexer", "Finds it later."],
          ["e3", "Reporter", "Tells people."],
        ],
      ],
    ],
    [
      ["in", "m1", "raw input"],
      ["m1", "m2", "parsed"],
      ["m1", "m3", "shortcut"],
      ["m2", "e1", "shaped"],
      ["e1", "e3", "saved ids"],
      ["e1", "e2", "documents"],
    ],
  ),
  shape(
    "fan past boxes",
    "One box fans out to four groups two stages on, past boxes in their rows.",
    [
      ["Config", [["config", "Settings", "One file of settings."]]],
      [
        "Services",
        [
          ["svc1", "Mailer", "Sends mail."],
          ["svc2", "Scheduler", "Runs jobs."],
          ["svc3", "Uploader", "Stores files."],
        ],
      ],
      [
        "Clients",
        [
          ["web", "Web app", "The main client."],
          ["mobile", "Mobile app", "The phone client."],
          ["cli", "Command line", "For scripts."],
          ["partner", "Partner API", "For other companies."],
        ],
      ],
    ],
    [
      ["config", "web", "feature flags"],
      ["config", "mobile", "feature flags"],
      ["config", "cli", "defaults"],
      ["config", "partner", "rate limits"],
      ["svc1", "web", "sent status"],
      ["svc2", "cli", "job ids"],
    ],
  ),
  shape(
    "many into one",
    "Five groups feed one, each with its own label.",
    [
      [
        "Signals",
        [
          ["logs", "Logs", "Lines from every service."],
          ["traces", "Traces", "Spans per request."],
          ["metrics", "Metrics", "Counters and gauges."],
          ["events", "Deploy events", "What shipped when."],
          ["alerts", "Alerts", "Pages and their notes."],
        ],
      ],
      ["View", [["board", "Incident board", "One page per incident."]]],
    ],
    [
      ["logs", "board", "error lines"],
      ["traces", "board", "slow spans"],
      ["metrics", "board", "spikes"],
      ["events", "board", "recent deploys"],
      ["alerts", "board", "who was paged"],
    ],
  ),
  shape(
    "three groups",
    "The smallest map: three groups, two links.",
    [
      ["Before", [["old", "Old format", "What files look like today."]]],
      ["Bridge", [["convert", "Converter", "Reads old, writes new."]]],
      ["After", [["new", "New format", "Smaller and versioned."]]],
    ],
    [
      ["old", "convert", "old files"],
      ["convert", "new", "new files"],
    ],
  ),
  shape(
    "six stages",
    "Six stages in a row: titles only, and the map scrolls.",
    [
      ["Capture", [["cap", "Capture"]]],
      ["Clean", [["clean", "Clean"]]],
      [
        "Label",
        [
          ["label", "Label"],
          ["review", "Spot check"],
        ],
      ],
      ["Train", [["train", "Train"]]],
      ["Evaluate", [["eval", "Evaluate"]]],
      ["Release", [["release", "Release"]]],
    ],
    [
      ["cap", "clean", "raw samples"],
      ["clean", "label", "clean samples"],
      ["label", "review", "one in fifty"],
      ["label", "train", "labelled set"],
      ["train", "eval", "model"],
      ["eval", "release", "scores"],
      ["cap", "eval", "held-out set"],
    ],
  ),
];
