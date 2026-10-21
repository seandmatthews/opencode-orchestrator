/* zcode-workflow
description: Implement a batch of Inference Refinery tickets end to end - one sequential worktree lane per ticket (implementer subagent, script-run fast-tier gates, independent reviewer with kick-back rounds, full e2e gate when the pipeline is touched, no-ff merge with the repo commit conventions, then the fast tier re-verified on main with auto-revert on red).
whenToUse: When this repo has forged, proposed tickets in docs/tickets/ ready to be implemented - pass the batch in dependency order. Lanes run strictly sequentially; a blocked lane keeps its branch and worktree for inspection and its dependents are skipped; every merge is decided by machine gates, never by claims.
args:
  tickets:
    type: json
    description: The ticket batch in dependency order, as an array of objects with id, slug, and deps fields. deps are enforced only for ids inside the batch; ids outside it are assumed already landed on main. Omitting it fails fast with an instruction message.
*/
const repo = "C:/Users/matth/Documents/opencode-orchestrator";
const laneRoot = "C:/Users/matth/Documents/orchestrator-lanes";
const IDENTITY = ["-c", "user.name=matth", "-c", "user.email=matth@local"];
// Every gate run's output is teed to a file here (2026-10-21 lesson: the first
// auto-revert, T-032, lost its red output entirely — the journal keeps only
// sliced tails, and the tree reproduced green afterward, so the bar is gone).
// The wrapper is node(1) itself via world.run: no fs in the script sandbox.
const REDLOG = "C:/swarm/verify-red";
const TEE = [
  "-e",
  "const cp=require('child_process'),fs=require('fs'),path=require('path');const out=process.argv[1],args=process.argv.slice(2);fs.mkdirSync(path.dirname(out),{recursive:true});const fd=fs.openSync(out,'w');const r=cp.spawnSync(process.execPath,args,{stdio:['ignore',fd,fd]});fs.closeSync(fd);const t=fs.readFileSync(out,'utf8');process.stdout.write('[full output: '+out+']\n'+t.slice(-4000));process.exit(r.status===null?-1:r.status);",
];

interface TicketSpec {
  /** Ticket id, e.g. T-013. */
  id: string;
  /** Slug from the ticket filename docs/tickets/<id>-<slug>.md; also names the lane branch and worktree. */
  slug: string;
  /** Ticket ids this lane must wait for. Ids inside this batch are enforced; ids outside it are assumed already landed. */
  deps: string[];
}

interface LaneRow {
  /** Ticket id, e.g. T-006. */
  ticket: string;
  /** Where the lane stands. */
  status: "queued" | "approved" | "merged" | "reverted" | "blocked" | "skipped";
  /** One sentence: what the lane did or why it stopped. */
  summary: string;
  /** Gates that decided the lane, or "-". */
  gates: string;
}

interface LaneImpl {
  /** True when the implementation is committed on the lane branch and the implementer believes it is done. */
  ok: boolean;
  /** Lane branch name, e.g. ticket/T-006-job-dag. */
  branch: string;
  /** Short sha of the tip commit on the lane branch. */
  commit: string;
  /** Scope for the merge message, e.g. "engine" or "store". */
  scope: string;
  /** Short title for the merge message. */
  title: string;
  /** Two sentences: what was built. */
  summary: string;
  /** Gates you ran yourself while iterating, with their outcome, e.g. "Gate 0+1 fast tier: exit 0". */
  gatesRun: string[];
  /** True if the diff touches the pipeline: src/runner.ts, adapters, gates, workspace handling, or report shape. When unsure, say true. */
  touchesPipeline: boolean;
  /** Anything done differently from the ticket text, and why. Empty list if none. */
  deviations: string[];
}

interface ReviewVerdict {
  /** True only when every acceptance criterion is demonstrably met and nothing would break. */
  pass: boolean;
  /** Concrete problems: file, what is wrong, and the evidence for it. Empty when passing. */
  issues: string[];
  /** True if the diff touches the pipeline (runner/adapters/gates/workspace/report shape), so the script must run the full e2e gate. Bias toward true when unsure. */
  needsGate2: boolean;
}

artifact.board("lanes", {
  title: "Ticket lanes",
  key: "ticket",
  status: "status",
  columns: ["queued", "approved", "merged", "reverted", "blocked", "skipped"],
  cardTitle: "ticket",
  detail: [{ field: "summary" }],
});

const queue: TicketSpec[] = Array.isArray(args.tickets) ? (args.tickets as TicketSpec[]) : [];
if (queue.length === 0) {
  throw new Error("No tickets given. Pass tickets: [{ id, slug, deps }], e.g. [{ id: \"T-013\", slug: \"shard-distillation\", deps: [\"T-009\"] }].");
}
const queueIds = new Set(queue.map((q: TicketSpec) => q.id));
for (const t of queue) {
  report({ ticket: t.id, status: "queued", summary: t.slug, gates: "-" }, "lanes");
}
log("Working " + queue.length + " tickets strictly sequentially: " + queue.map((q: TicketSpec) => q.id).join(", "));

const landedIds: string[] = [];
const stoppedIds: string[] = [];
const laneNotes: LaneRow[] = [];

phase("Land any pending package-lock change on main");
let choreNote = "nothing to land — package-lock.json was already clean";
const lockDirty = await world.run("git", ["-C", repo, "diff", "--quiet", "--", "package-lock.json"]);
if (lockDirty.exitCode !== 0) {
  const b = "chore/package-lock-" + String(queue[0] ? queue[0].id : "batch").toLowerCase();
  await world.run("git", ["-C", repo, "checkout", "-b", b]);
  await world.run("git", ["-C", repo, "add", "package-lock.json"]);
  const c = await world.run("git", [...IDENTITY, "commit", "-m", "chore(deps): land pending package-lock.json change before the ticket lanes"]);
  if (c.exitCode !== 0) throw new Error("chore commit failed: " + (c.stdout + c.stderr).slice(-500));
  await world.run("git", ["-C", repo, "checkout", "main"]);
  const m = await world.run("git", [...IDENTITY, "merge", "--no-ff", b, "-m", "merge: deps — pending package-lock.json change"]);
  if (m.exitCode !== 0) throw new Error("chore merge failed: " + (m.stdout + m.stderr).slice(-500));
  const post = await world.run("node", [...TEE, REDLOG + "/chore-post-merge-fast.log", repo + "/scripts/verify.mjs", "fast"], { timeoutMs: 300000 });
  if (post.exitCode !== 0) throw new Error("fast tier red on main after the chore merge — aborting before any ticket lane: " + (post.stdout + post.stderr).slice(-800));
  await world.run("git", ["-C", repo, "branch", "-d", b]);
  choreNote = "pending package-lock.json change merged to main, fast tier green";
}
log(choreNote);

for (const t of queue) {
  const unmet = t.deps.filter((d: string) => queueIds.has(d) && !landedIds.includes(d));
  if (unmet.length > 0) {
    const row: LaneRow = { ticket: t.id, status: "skipped", summary: "depends on " + unmet.join(", ") + ", which did not land", gates: "-" };
    laneNotes.push(row);
    report(row, "lanes");
    continue;
  }

  const laneDir = laneRoot + "/" + t.id;
  const branch = "ticket/" + t.id + "-" + t.slug;
  const implementer = agent("implementer-" + t.id, {
    system:
      "Senior TypeScript engineer implementing a precisely specified ticket in the Inference Refinery repo (Windows, Git Bash). You follow the repo charter AGENTS.md exactly: list-form subprocess calls, model IDs only as CLI config, the canonical checkout is never touched, VERIFICATION.md extends in the same change-set, a zero-byte diff is a NO-OP, no weakened assertions, honest reporting. If the ticket contradicts the code or the locked decisions, or a gate is impossible to pass, stop and escalate plainly rather than working around it.",
  });
  const reviewer = agent("reviewer-" + t.id, {
    system:
      "Independent code reviewer for the Inference Refinery repo. You hunt for what would break: acceptance criteria not demonstrably met, weakened or fake gate assertions, ride-along changes beyond the ticket, AGENTS.md violations (string-joined subprocess commands, model IDs in engine code), missing VERIFICATION.md extension, ticket/index not updated in the same change-set. You never edit files, never commit, and never run the model-token e2e gate (the driving script runs the gates itself; cheap local checks like typecheck are fine). Approving takes evidence; objecting is the easy move. If you cannot review with what you have, escalate plainly.",
  });

  phase("Implement the ticket in its worktree lane");
  const firstAsk = [
    "Implement ticket " + t.id + " of the Inference Refinery repo at " + repo + ". The ticket file is the spec of record:",
    repo + "/docs/tickets/" + t.id + "-" + t.slug + ".md",
    "",
    "Read first, in this order:",
    "1. " + repo + "/AGENTS.md — the charter; its ground rules are non-negotiable.",
    "2. " + repo + "/docs/decisions.md — locked decisions; do not relitigate.",
    "3. The ticket file above — What / Why / Acceptance criteria, each criterion naming its pinning gate.",
    "4. " + repo + "/VERIFICATION.md — gate tiers and the per-ticket definition of done.",
    "",
    "Lane setup (never work in the main checkout, never touch main, never merge):",
    "- If " + laneDir + " already exists, clear it first (rm -rf the path, then git -C " + repo + " worktree prune).",
    "- git -C " + repo + " worktree add " + laneDir + " -b " + branch,
    "- cd " + laneDir + " && npm install (node_modules is not shared with the main checkout).",
    "",
    "Implement exactly the ticket — no ride-along changes. If package-lock.json ends up modified in the lane, leave it out of the commit. Extend VERIFICATION.md and add the gate script the ticket names in the same change-set; wire new checks into scripts/verify.mjs exactly as the ticket says. Flip the ticket status to done (fill ## Landed with what actually changed and the gate numbers you measured) and update the index row in docs/tickets/README.md — all in the same commit.",
    "",
    "While iterating, run in the lane: node scripts/verify.mjs fast (Gate 0+1, seconds) at minimum, plus any pinned fast-tier gate the ticket names. Do NOT run verify:full yourself — the driving script re-runs the fast tier after you, and runs the full e2e gate (real model tokens, minutes) when the pipeline is touched; report touchesPipeline honestly.",
    "",
    "Commit on the lane branch: git -c user.name=matth -c user.email=matth@local commit, message \"feat(<scope>): <description> (" + t.id + ")\". A claimed-but-red gate will bounce the lane, so report honestly. Reply with the structured result.",
  ].join("\n");

  let impl: LaneImpl | null = null;
  let issues: string | null = null;
  let approved = false;
  const gatesDecided: string[] = [];

  for (let round = 1; round <= 4; round++) {
    if (round === 1) {
      impl = await implementer.ask<LaneImpl>(firstAsk);
    } else {
      impl = await implementer.ask<LaneImpl>(
        "The lane did not pass review round " + (round - 1) + ". Address every issue below on the same branch (" + branch + " in " + laneDir + "), amend or add commits, and reply with the same structured result. Do not weaken assertions to go green.\n\nIssues:\n" + issues,
      );
    }

    let fast;
    try {
      fast = await world.run("node", [...TEE, REDLOG + "/" + t.id + "-lane-fast.log", laneDir + "/scripts/verify.mjs", "fast"], { timeoutMs: 300000 });
    } catch (e) {
      fast = { exitCode: -1, stdout: "", stderr: "gate spawn/timeout: " + String(e) };
    }
    if (fast.exitCode !== 0) {
      issues = "Fast tier (Gate 0+1) red, exit " + fast.exitCode + ":\n" + (fast.stdout + "\n" + fast.stderr).slice(-2000);
      log(t.id + " round " + round + ": fast tier red, kicking back to the implementer");
      continue;
    }
    if (!gatesDecided.includes("fast tier exit 0")) gatesDecided.push("fast tier exit 0");

    phase("Independent review of the lane");
    const rev: ReviewVerdict = await reviewer.ask<ReviewVerdict>(
      "Review lane " + t.id + ". The implementer claims the ticket is implemented on branch " + branch + ", worktree " + laneDir +
      " (committed tip " + (impl ? impl.commit : "?") + "). The fast tier just passed exit 0, run by the script.\n\n" +
      "1. Read the ticket file, then the change: git -C " + laneDir + " diff main...HEAD, and read the changed files in the lane.\n" +
      "2. Judge each acceptance criterion against the code and the new gate scripts: is each criterion actually pinned, and does the gate assert what the ticket says (not less)? Hunt for ride-alongs, weakened checks, AGENTS.md violations, missing VERIFICATION.md extension, ticket/index not updated in the same commit.\n" +
      "3. Decide needsGate2: does the diff touch the pipeline (src/runner.ts, adapters, gates, workspace handling, report shape)? Bias toward true when unsure — the script spends the e2e tokens when it is true.\n\n" +
      "Reply with the verdict. In issues, be concrete: file, what, evidence.",
    );
    if (!rev.pass) {
      issues = rev.issues.length > 0
        ? rev.issues.map((i: string) => "- " + i).join("\n")
        : "the reviewer did not pass the lane but listed no issues — re-examine your diff against every acceptance criterion and the definition of done, fix what you find, and report again";
      log(t.id + " round " + round + ": review flagged " + rev.issues.length + " issue(s), kicking back");
      continue;
    }

    if ((impl && impl.touchesPipeline) || rev.needsGate2) {
      phase("Prove the lane with the full e2e gate");
      let full;
      try {
        full = await world.run("node", [...TEE, REDLOG + "/" + t.id + "-gate2-full.log", laneDir + "/scripts/verify.mjs", "full"], { timeoutMs: 1500000 });
      } catch (e) {
        full = { exitCode: -1, stdout: "", stderr: "gate spawn/timeout: " + String(e) };
      }
      if (full.exitCode !== 0) {
        issues = "Gate 2 (verify:full, real e2e) red, exit " + full.exitCode + ":\n" + (full.stdout + "\n" + full.stderr).slice(-2500);
        log(t.id + " round " + round + ": Gate 2 red, kicking back to the implementer");
        continue;
      }
      if (!gatesDecided.includes("Gate 2 verify:full exit 0")) gatesDecided.push("Gate 2 verify:full exit 0");
    }

    approved = true;
    if (impl) {
      const row: LaneRow = { ticket: t.id, status: "approved", summary: impl.summary, gates: gatesDecided.join("; ") };
      report(row, "lanes");
    }
    break;
  }

  if (!approved || impl === null || !impl.ok) {
    const row: LaneRow = {
      ticket: t.id,
      status: "blocked",
      summary: "not approved after 4 rounds — lane branch " + branch + " and worktree " + laneDir + " left in place for inspection. Last issues: " + (issues ?? "implementer reported not-ok").slice(0, 400),
      gates: gatesDecided.join("; ") || "-",
    };
    laneNotes.push(row);
    report(row, "lanes");
    stoppedIds.push(t.id);
    continue;
  }

  phase("Merge the lane into main and re-verify");
  const merge = await world.run("git", [...IDENTITY, "merge", "--no-ff", branch, "-m", "merge: " + (impl.scope || "engine") + " — " + (impl.title || t.slug) + " (" + t.id + ")"]);
  if (merge.exitCode !== 0) {
    const row: LaneRow = { ticket: t.id, status: "blocked", summary: "merge to main failed (lane left in place): " + (merge.stdout + merge.stderr).slice(-400), gates: gatesDecided.join("; ") };
    laneNotes.push(row);
    report(row, "lanes");
    stoppedIds.push(t.id);
    continue;
  }
  const mergeSha = await world.run("git", ["-C", repo, "rev-parse", "--short", "HEAD"]);
  const post = await world.run("node", [...TEE, REDLOG + "/" + t.id + "-post-merge-fast.log", repo + "/scripts/verify.mjs", "fast"], { timeoutMs: 300000 });
  if (post.exitCode !== 0) {
    const rv = await world.run("git", [...IDENTITY, "revert", "-m", "1", "--no-edit", mergeSha.stdout.trim()]);
    if (rv.exitCode !== 0) {
      throw new Error("Post-merge fast tier red AND the revert failed on " + repo + " — manual intervention needed. Merge was " + mergeSha.stdout.trim());
    }
    const row: LaneRow = { ticket: t.id, status: "reverted", summary: "merged as " + mergeSha.stdout.trim() + " then auto-reverted: fast tier red on main after the merge. Lane kept for inspection.", gates: gatesDecided.join("; ") + "; post-merge fast tier RED" };
    laneNotes.push(row);
    report(row, "lanes");
    stoppedIds.push(t.id);
    continue;
  }
  const row: LaneRow = { ticket: t.id, status: "merged", summary: impl.summary + " (merge " + mergeSha.stdout.trim() + (impl.deviations.length > 0 ? "; deviations: " + impl.deviations.join("; ") : "") + ")", gates: gatesDecided.join("; ") + "; post-merge fast tier exit 0" };
  laneNotes.push(row);
  report(row, "lanes");
  landedIds.push(t.id);
  log(t.id + " merged as " + mergeSha.stdout.trim() + ", main green");

  await world.run("node", ["-e", "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", laneDir + "/node_modules"]);
  await world.run("git", ["-C", repo, "worktree", "remove", "--force", laneDir]);
  await world.run("git", ["-C", repo, "branch", "-d", branch]);
}

phase("Summarize the batch");
const merged = laneNotes.filter((r) => r.status === "merged").length;
const lines: string[] = [
  "# Ticket batch report",
  "",
  "Queue: " + queue.map((q: TicketSpec) => q.id).join(", "),
  "",
  "Merged " + merged + " of " + queue.length + " lanes. " + choreNote + ".",
  "",
  "| Ticket | Status | Gates that decided it | Notes |",
  "|---|---|---|---|",
  ...laneNotes.map((r) => "| " + r.ticket + " | " + r.status + " | " + r.gates + " | " + r.summary.replace(/\|/g, "\\|") + " |"),
];
await artifact.markdown("batch-report", lines.join("\n"), {
  title: "Ticket batch — " + queue.map((q: TicketSpec) => q.id).join(", "),
  description: "Per-lane outcome: what merged, what was blocked, which gates decided each.",
  primary: true,
});

const blocked = laneNotes.filter((r) => r.status === "blocked" || r.status === "reverted");
return {
  conclusion:
    merged === queue.length
      ? "All " + queue.length + " tickets implemented, gated, and merged to main; every merge was re-verified green on main."
      : merged + " of " + queue.length + " lanes merged to main with green gates. Stopped: " + (stoppedIds.join(", ") || "none") + ". Skipped for unmet dependencies: " + laneNotes.filter((r) => r.status === "skipped").map((r) => r.ticket).join(", ") + ". Blocked lanes left their branches and worktrees in place for inspection.",
  findings: blocked.map((r) => ({
    where: r.ticket,
    what: r.status + ": " + r.summary,
    evidence: "gates that ran: " + r.gates + "; lane worktree left on disk under " + laneRoot,
    status: "verified" as const,
    severity: "high" as const,
  })),
  verified: [
    "every lane: scripts/verify.mjs fast (Gate 0 typecheck + Gate 1 fixture + the fast-tier gates the tickets pin) run by the script itself in the lane worktree",
    "pipeline-touching lanes: scripts/verify.mjs full (Gate 2, real e2e run with model tokens) run by the script before merge",
    "after every merge to main: fast tier re-run on main; a red result auto-reverts the merge",
    "each merged lane passed an independent fresh-context reviewer against the ticket's acceptance criteria",
  ],
  notCovered: [
    "tickets that were skipped for unmet dependencies were not started",
    "the reviewer's judgment is advisory; the machine gates decided every merge",
  ],
};
