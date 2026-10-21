/* zcode-workflow
description: "Turn ONE idea into a reviewed, code-grounded opencode-orchestrator
  ticket: a scout grounds the idea in what the repo, spec, and gates actually
  contain today; the writer drafts it in the docs/tickets/ house format; a fresh
  reality-check reviewer reads every file the ticket names and confirms the
  problem is real and every acceptance criterion is pinnable by a named gate; on
  sign-off the ticket + index row are committed to main as one docs(tickets)
  commit — otherwise flagged and left uncommitted."
whenToUse: When you have ONE improvement idea for the Inference Refinery
  orchestrator (engine, adapters, verification, ops, docs) that should become a
  backlog ticket. It dedupes against open tickets and locked decisions, sizes
  the idea to one mergeable change-set, and a reviewer must pass before it
  commits. Modeled on pigeon-simulator's pigeon-ticket-forge; use that one for
  the pigeon game.
args:
  idea:
    type: string
    description: "The improvement idea, in one or two plain sentences: what should
      change and why it matters."
    required: true
  reviewRounds:
    type: number
    description: Max reality-check review rounds before the run is flagged for human
      attention.
    required: false
    default: 3
*/
// Inference Refinery (opencode-orchestrator) — ticket forge: idea in, a
// reviewed, code-grounded ticket out. Adapted from pigeon-simulator's
// pigeon-ticket-forge. The house lesson this repo already paid for
// (VERIFICATION.md Known issue #1): every check reported PASS while the
// workers edited the wrong repository — a self-consistent green is not truth.
// So a ticket is never signed off on its own coherence: a scout grounds the
// idea in what the repo/spec/gates ACTUALLY contain today, the writer drafts
// from that grounding, and a fresh reviewer reads every file the ticket names
// before the ticket may land. On sign-off the ticket (+ its index row) is
// committed to main as one docs(tickets) commit; anything else is flagged and
// left uncommitted for human attention.

const ROOT = "C:/Users/matth/Documents/opencode-orchestrator";
const ideaText = String(args.idea ?? "").trim();
const maxRounds = typeof args.reviewRounds === "number" && args.reviewRounds >= 1 ? Math.floor(args.reviewRounds) : 3;

interface Grounding {
  /** One sentence: how the idea maps onto the repo as it stands today. */
  mapping: string;
  /** Evidence the problem is real: files/lines/spec sections actually read, with what each showed. */
  evidence: string;
  /** Existing tickets that overlap (id + one line each); empty when none. */
  overlaps: string[];
  /** Locked decisions (docs/decisions.md) that bind this idea, cited; empty when none. */
  constraints: string[];
  /** Which existing gate/check can pin the acceptance criteria, or what new check the ticket must add. */
  pinning: string;
  /** Suggested Category (engine|adapters|verification|docs|ops) with a one-line why. */
  category: string;
  /** Suggested Value 1-5 and Risk 1-5, each with a one-line justification. */
  rating: string;
  /** The one mergeable change-set to actually ticket, if the idea arrived milestone-sized. */
  carve: string;
  /** True when the idea duplicates an open ticket or relitigates a locked decision. */
  dead: boolean;
  /** Why dead, when dead. */
  deadReason: string;
}

interface TicketDraft {
  /** Assigned id, e.g. "T-003". */
  id: string;
  title: string;
  /** One of: engine, adapters, verification, docs, ops. */
  category: string;
  /** Repo-relative path of the written ticket file. */
  path: string;
  /** Full markdown content of the ticket file. */
  content: string;
  /** True once the row exists in docs/tickets/README.md. */
  indexed: boolean;
}

interface TicketReview {
  /** "pass" only when every claim about code/spec was confirmed by reading it, and every acceptance criterion is pinnable by its named gate/check. */
  verdict: "pass" | "changes";
  /** Blocking issues — must be empty on pass. Each names the file and the problem. */
  blocking: string[];
  /** What you checked against what: files opened, spec sections read, verdicts reached. */
  evidence: string;
}

interface CommitResult {
  status: "committed" | "blocked";
  /** Short commit hash, empty when blocked. */
  commit: string;
  /** Empty when committed; otherwise why. */
  blocker: string;
}

interface ReaderReport {
  /** False when the report has gaps worth fixing before publishing. */
  ok: boolean;
  /** Concrete problems: unclear passages, unsupported claims, missing facts. */
  issues: string[];
}

interface WorkflowReport {
  conclusion: string;
  findings: {
    /** Ticket path that carries the outcome. */
    where: string;
    /** One sentence: what happened to it. */
    what: string;
    /** The review evidence and/or commit. */
    evidence: string;
    /** "verified" when the reviewer checked the draft and the file exists on disk; else "unconfirmed". */
    status: "verified" | "unconfirmed";
    severity: "low" | "medium" | "high";
  }[];
  verified: string[];
  notCovered: string[];
}

const HONESTY =
  "Never present a check you did not run as evidence. If something is impossible, or your instructions contradict each other, escalate and say so plainly rather than working around it. " +
  "SHELL HYGIENE: this machine's shell is Git Bash, not cmd.exe — cmd-isms like `rmdir /s /q ... > nul 2>&1` create junk (a real file named nul, phantom /s and /q paths). Use POSIX syntax (rm -rf), and if you accidentally create a file named nul in the repo, delete it before you finish. ";

const out = {
  flagged: false,
  flagReason: "",
  committed: false,
  commit: "",
  commitConfirmed: false,
  roundsUsed: 0,
  lastVerdict: "",
};

if (ideaText === "") {
  return {
    conclusion: "Aborted before any work: the idea argument was empty. Nothing was changed.",
    findings: [],
    verified: [],
    notCovered: ["everything — no idea was given"],
  } satisfies WorkflowReport;
}

// One persistent ticket writer for the whole run — the draft and every
// review-round revision, so it carries its own context between kick-backs.
const writer = agent("ticket-writer", {
  system:
    "You are the ticket writer for the Inference Refinery orchestrator. You write technically specific, standalone ticket files that a stranger could implement without asking questions, in the house format of docs/tickets/README.md (model on T-002 for style). AGENTS.md ground rules are law: one ticket is one mergeable change-set; every acceptance criterion names the gate or check that pins it; the engine stays model/harness-agnostic; gates decide survival, models advise; subprocess calls are list-form. " +
    HONESTY,
});

// ---------- ground the idea ----------

phase("Ground the idea in the repo");
const scout = agent("repo-scout", {
  system:
    "You are the repo scout for the Inference Refinery orchestrator. Your job: before anyone words a ticket, establish what the repository, the spec, and the verification gates ACTUALLY contain today. You are skeptical of your own priors and of plausible-sounding architecture: this repo once reported all-PASS while workers edited the wrong repository (VERIFICATION.md Known issue #1), and zero-byte diffs were once blessed as passes (AGENTS.md #7) — memory and coherence are exactly what you exist to replace with files read and lines cited. You never edit any file. " +
    HONESTY,
});
const grounding = await scout.ask<Grounding>(
  "THE IDEA (from the repo's owner): " + ideaText + "\n\n" +
    "Work in the checkout at " + ROOT + ".\n\n" +
    "1. GROUND: read AGENTS.md, docs/decisions.md, docs/ROADMAP.md, VERIFICATION.md, and every file in docs/tickets/. Then read the actual code and spec the idea touches — src/, scripts/, docs/spec/inference-refinery-v2.md (cite section numbers) — following imports until you can say what exists and what is missing. Establish with file:line evidence you actually read: whether the problem is real (a claim you cannot confirm by reading is called out as unconfirmed, never smoothed over), which existing gate/check could pin each acceptance criterion (VERIFICATION.md gates 0/0.5/1/1.5/2/3) or what new check the ticket itself would have to add, which open or done tickets overlap, and which locked decisions bind the idea.\n" +
    "2. SIZE IT: one ticket = one mergeable change-set. If the idea arrived milestone-sized (e.g. all of stage 1), carve the smallest useful slice and say exactly what you carved off for later tickets.\n" +
    "3. RATE: Category (engine|adapters|verification|docs|ops), Value 1-5 (project value of shipping it), Risk 1-5 (likelihood the change breaks something), each justified in one line.\n" +
    "4. DEAD CHECK: a duplicate of an open ticket, or a relitigation of a locked decision (docs/decisions.md), is dead — say so plainly rather than dressing it up as a new ticket.\n" +
    "Return the Grounding.",
);
if (grounding.dead) {
  out.flagged = true;
  out.flagReason = "the idea did not survive grounding: " + grounding.deadReason + " — no ticket was written.";
  log("grounding: DEAD — " + grounding.deadReason);
} else {
  log("grounding: " + grounding.mapping + " (" + grounding.overlaps.length + " overlapping ticket(s), " + grounding.constraints.length + " locked decision(s) cited)");
}

// ---------- draft the ticket ----------

let draft: TicketDraft | null = null;
if (!out.flagged) {
  phase("Draft the ticket");
  const first = await writer.ask<TicketDraft>(
    "Turn the owner's idea into the next ticket. Repo: " + ROOT + " (work in the main checkout, docs only).\n\n" +
      "THE IDEA: " + ideaText + "\n\n" +
      "GROUNDING from the repo scout (mandatory input — the ticket must be consistent with what the scout verified by reading, never with memory):\n" +
      JSON.stringify(grounding, null, 1) + "\n\n" +
      "1. Read docs/tickets/README.md (format block + index) and docs/tickets/T-002-run-artifact-cleanup.md for style; take the next free T-number from the index.\n" +
      "2. Write docs/tickets/<ID>-<short-name>.md with Status: proposed, and add its row to the index table (| ID | Ticket | Priority | Status | — Priority high|medium|low from your Value/Risk; Status: proposed). Change nothing else in the index.\n" +
      "3. House format exactly:\n" +
      "# <ID> — <title>\n" +
      "**Status:** proposed\n" +
      "**Category:** <one of: engine, adapters, verification, docs, ops>\n" +
      "**Value (1-5):** <v> · **Risk (1-5):** <r>\n" +
      "**Depends on:** <ticket ids or —>\n" +
      "## What — the change, technically specific: files, seams, CLI flags, what it does NOT claim\n" +
      "## Why — the pain or spec gap plus the evidence the scout verified\n" +
      "## Acceptance criteria — checkbox list; every criterion names the gate or check that pins it (Gate 0/0.5/1/1.5/2/3, or a new check this ticket adds)\n" +
      "## Verification — which gates run\n" +
      "(omit ## Landed — nothing has landed)\n" +
      "4. Ticket ONLY the scout's carved change-set, and cite the files and spec sections the scout verified. Respect the AGENTS.md ground rules in the wording.\n" +
      "Return the TicketDraft (path repo-relative; content = full markdown).",
  );
  draft = first;
  log("ticket " + first.id + " drafted: " + first.title);
}

// ---------- reality-check review loop ----------

if (!out.flagged && draft !== null) {
  phase("Reality-check review");
  const ticket: TicketDraft = draft;
  const reviewer = agent("ticket-reviewer", {
    system:
      "You are the ticket reviewer for the Inference Refinery orchestrator. You review the WORDING of a ticket before it lands: would an implementer be told the truth? You have not seen the draft being made and owe it no courtesy. You never edit any file; the Read tool, the repo's code and spec, and your own skepticism are your instruments. Your standing grudges: this repo once reported all-PASS while every worker edited the wrong repository, and gates once blessed untouched worktrees — you exist so a self-consistent ticket never ships unverified again. EVERY ticket gets checked against the code and spec it names. " +
      HONESTY,
  });
  let feedback = "";
  for (let round = 1; round <= maxRounds; round++) {
    out.roundsUsed = round;
    const verdict = await reviewer.ask<TicketReview>(
      "Review ticket draft " + ticket.id + " (\"" + ticket.title + "\") — round " + round + " of at most " + maxRounds + ". Repo: " + ROOT + "." +
        (feedback !== "" ? "\n\nYOUR PREVIOUS VERDICT sent this back; check each item is actually fixed:\n- " + feedback : "") +
        "\n\n1. Read " + ticket.path + " in full.\n" +
        "2. CODE/SPEC CHECK — mandatory for EVERY ticket: open every file and spec section the ticket names (## What, ## Why, the acceptance criteria) and read enough surrounding code to judge. Verify the ticket's claims about the current state are TRUE — the seam is really missing, the command really behaves as described, the spec section really says what is claimed. Verify the proposed change WOULD solve the claimed problem as specified (right site, right mechanism, genuinely one mergeable change-set). A claim about code or spec you cannot confirm by reading it is a blocking problem; a fix aimed at the wrong site or mechanism is a blocking problem; a stale line number is NOT blocking — note it as drift to correct during implementation.\n" +
        "3. CHECKABLE: every acceptance criterion names a pinning gate or check that exists (VERIFICATION.md: Gate 0/0.5/1/1.5/2/3) or that the ticket itself adds — and that check could actually decide pass/fail for the criterion. An uncheckable criterion, or one whose named check cannot catch the failure mode the ticket exists to fix, is a blocking problem.\n" +
        "4. GROUND RULES: AGENTS.md is law — the engine stays model/harness-agnostic, gates decide survival (models advise), the canonical checkout is never handed to a model, subprocess calls are list-form, every feature extends VERIFICATION.md in the same change-set, a zero-byte diff is a NO-OP. A ticket that violates one is a blocking problem.\n" +
        "5. FIT: read docs/decisions.md and docs/tickets/README.md — does this duplicate an open ticket, contradict a landed one, or relitigate a locked decision? Then it is a blocking problem.\n\n" +
        "VERDICT DISCIPLINE: \"changes\" only for blocking problems — an unconfirmed claim, a wrong site or mechanism, an unpinnable criterion, a ground-rule violation, a duplicate, or a contradiction. Writing style alone never blocks. If the problem is real, the fix would work, and every claim matches the repo, PASS.\n\n" +
        "Return the TicketReview.",
    );
    out.lastVerdict = verdict.verdict;
    if (verdict.verdict === "pass") {
      log("round " + round + ": ticket review PASS — " + verdict.evidence.slice(0, 200));
      break;
    }
    feedback = verdict.blocking.join("\n- ");
    log("round " + round + ": review sent the ticket back — " + verdict.blocking.length + " blocking issue(s)");
    if (round < maxRounds) {
      const revised = await writer.ask<TicketDraft>(
        "The reviewer sent ticket " + ticket.id + " back (round " + round + "). Fix EVERY one of these in " + ticket.path +
          " (and the index row if affected):\n- " + feedback +
          "\n\nKeep the house format; do not weaken a criterion to escape the criticism — fix the ticket to be true. Return the TicketDraft again.",
      );
      ticket.id = revised.id;
      ticket.title = revised.title;
      ticket.category = revised.category;
      ticket.path = revised.path;
      ticket.content = revised.content;
      ticket.indexed = revised.indexed;
    }
  }
  if (out.lastVerdict !== "pass") {
    out.flagged = true;
    out.flagReason = "ticket was not accepted within " + maxRounds + " review rounds (last verdict: " + out.lastVerdict + ") — the draft is left UNCOMMITTED in the working tree at " + ticket.path + " for human attention; last blocking items:\n- " + feedback;
  }
}

// ---------- land on sign-off ----------

if (!out.flagged && draft !== null) {
  phase("Land the ticket in the repo");
  const ticket: TicketDraft = draft;
  const registrar = agent("registrar", {
    system:
      "You are a careful git registrar. You stage exactly the files you are told — never more — and commit with the given message and identity. You never push, never rebase, never touch unrelated files. " +
      HONESTY,
  });
  const committed = await registrar.ask<CommitResult>(
    "Commit the signed-off ticket in " + ROOT + " (branch main). Stage ONLY:\n" +
      "- " + ROOT + "/" + ticket.path + "\n" +
      "- docs/tickets/README.md\n" +
      "\nCommit message: docs(tickets): " + ticket.title + " (" + ticket.id + ")\n" +
      "This machine has NO global git identity — commit with:\n" +
      "git -c user.name=matth -c user.email=matthews.sean.d@gmail.com commit -m \"docs(tickets): " + ticket.title + " (" + ticket.id + ")\"\n" +
      "Never push, never rebase, never stage unrelated files. If anything unexpected is already staged or the commit fails, git reset to a clean staged-nothing state and return status blocked with the reason. Return the CommitResult (short hash in commit).",
  );
  if (committed.status !== "committed") {
    out.flagged = true;
    out.flagReason = "ticket was accepted but the commit failed: " + committed.blocker + " — the draft is left in the working tree uncommitted; HUMAN INTERVENTION REQUIRED.";
  } else {
    out.committed = true;
    out.commit = committed.commit;
    const logCheck = await world.run("git", ["-C", ROOT, "log", "--oneline", "-1"]);
    out.commitConfirmed = logCheck.exitCode === 0 && out.commit !== "" && logCheck.stdout.indexOf(out.commit) !== -1;
    log("ticket " + ticket.id + " landed as " + out.commit + (out.commitConfirmed ? " (confirmed in git log)" : " (could NOT confirm in git log)"));
  }
}

// ---------- verify on disk + report ----------

phase("Write the run report");
let onDisk = false;
if (draft !== null) {
  try {
    const disk = await files.read(draft.path);
    onDisk = disk.length > 0 && disk.indexOf("## Acceptance criteria") !== -1;
  } catch {
    onDisk = false;
  }
}
let md = "# Ticket forge — " + (draft !== null ? draft.id + " \"" + draft.title + "\"" : "no ticket") + "\n\n";
md += "**The idea:** " + ideaText + "\n\n";
md += "**Outcome:** " + (out.committed
  ? "SIGNED OFF and COMMITTED as " + out.commit + (out.commitConfirmed ? " (confirmed in git log)" : " (NOT confirmed in git log)") + " — " + (draft !== null ? draft.path : "")
  : "FLAGGED — not committed. " + out.flagReason) + "\n\n";
if (draft !== null) {
  md += "## Grounding\n\n" + grounding.mapping + "\n\n- Overlaps: " + (grounding.overlaps.length > 0 ? grounding.overlaps.join("; ") : "none") + "\n- Locked decisions cited: " + (grounding.constraints.length > 0 ? grounding.constraints.join("; ") : "none") + "\n- Pinning: " + grounding.pinning + "\n- Carve: " + grounding.carve + "\n\n";
  md += "## Ticket\n\n" + draft.content + "\n\n";
}
md += "## Review\n\n- Rounds used: " + out.roundsUsed + " of " + maxRounds + "\n- Final verdict: " + (out.lastVerdict || "never reached") + "\n";
const reader = agent("report-reader", {
  system:
    "You are a cold reader: you judge a report purely as a reader would, from the text alone. You do not verify claims against the repository and you do not edit files. You name what is unclear, what the text fails to support, and what a developer reading it would still be missing. " +
    HONESTY,
});
const readerOut = await reader.ask<ReaderReport>(
  "Read this report and tell me what is wrong with it as a piece of writing for the repo's owner deciding what to do next:\n\n" + md +
    "\n\nAnswer with ok (false when there are gaps worth fixing) and a list of concrete issues. Return ONLY the ReaderReport.",
);
let finalMd = md;
if (!readerOut.ok && readerOut.issues.length > 0) {
  const fixer = agent("report-fixer", {
    system: "You rewrite reports to fix flagged problems without inventing facts. Return ONLY the full corrected markdown.",
  });
  finalMd = await fixer.ask(
    "A cold reader flagged these problems in the report below:\n" + readerOut.issues.map((i) => "- " + i).join("\n") +
      "\n\nRewrite the report fixing every one (keep all facts; improve wording, structure and flagging only). Return ONLY the full corrected markdown.\n\n" + md,
  );
}
await artifact.markdown("report", finalMd, {
  title: "Ticket forge report — " + (draft !== null ? draft.id : "untracked"),
  description: (out.committed ? "committed as " + out.commit : "FLAGGED") + " · " + out.roundsUsed + " review round(s)",
  primary: true,
});

return {
  conclusion: out.committed
    ? "Idea \"" + ideaText.slice(0, 80) + "\" became ticket " + (draft !== null ? draft.id : "?") + " (\"" + (draft !== null ? draft.title : "?") + "\"), grounded in the repo by the scout, passed the reality-check review in " + out.roundsUsed + " round(s), and landed as commit " + out.commit + "."
    : "FLAGGED — the ticket did not land: " + out.flagReason,
  findings: [
    {
      where: draft !== null ? draft.path : "no ticket",
      what: out.committed
        ? "ticket grounded in the repo, code/spec-checked by a fresh reviewer, committed with its index row"
        : "not committed: " + out.flagReason,
      evidence: (out.commit !== "" ? "commit " + out.commit + (out.commitConfirmed ? " (confirmed in git log)" : " (not confirmed)") + "; " : "") +
        "ticket on disk with acceptance criteria: " + onDisk + "; review rounds: " + out.roundsUsed,
      status: (onDisk ? "verified" : "unconfirmed") as "verified" | "unconfirmed",
      severity: (out.flagged ? "high" : "low") as "low" | "high",
    },
  ],
  verified: [
    ...(draft !== null ? ["ticket file exists on disk with an Acceptance criteria block (script read it back)"] : []),
    "scout grounded the idea by reading the repo, spec, and gates with cited evidence",
    "reviewer read the code and spec the ticket names and confirmed the problem is real and every criterion is pinnable",
    ...(out.committed ? [(out.commitConfirmed ? "committed to main as " + out.commit + " and confirmed in git log" : "commit reported as " + out.commit + " but NOT confirmed in git log")] : []),
  ],
  notCovered: [
    "the idea's eventual IMPLEMENTATION — this run only produces the ticket",
    "spec sections and code paths the idea did not touch were not read",
  ],
} satisfies WorkflowReport;