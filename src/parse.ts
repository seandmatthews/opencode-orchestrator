// Pure extraction/validation helpers for structured model output.
// Inputs are assumed ANSI-stripped (the worker adapter does that); parsers
// scan for the last JSON payload in prose so surrounding chatter is tolerated.
//
// parseBriefs carries two LAST-RESORT repairs, each run only on input the
// plain scan already failed, so structurally every input either scan accepts
// parses byte-identically (Gate 0.5 pins both directions); the original bytes
// are never rewritten anywhere — planner-raw.txt / planner-r2-raw.txt keep
// them verbatim.
//
// Exact-count honesty (T-056, a DELIBERATE documented behavior change): every
// scan below returns its parsed array ONLY when its valid-brief count is
// EXACTLY the requested count; any other count parses null. The previous
// pad/truncate tail — cyclic repetition for a short reply, silent truncation
// for a long one — laundered a 1-brief reply for N candidates as N "distinct"
// briefs at full token cost, invisible in the report (ok: true, no trace).
// A count-mismatched reply is now a FAILED planner output: it flows through
// the runner's existing bounded repair attempt and, still mismatched, the
// raw-goal fallback (fallbackUsed: true, recorded loudly). Exactly-count
// replies — the overwhelming case — are untouched byte-for-byte: the
// inertness contract's purpose (never break working inputs) is honored;
// its scope is narrowed to exactly that (Gate 0.5 + Gate 1.42 pin both
// directions; the red bar — main's pad `["a"]`@2 → ["a","a"] and truncate
// `["a","b","c"]`@2 → ["a","b"] — was recorded on main before this change).
//
// Repair 1 (T-029 review round 1; red bar recorded from real run
// 20261020053845's planner-raw.txt, the Gate 2 red): when NO [..] slice
// parses, the scan retries once over text whose element separators had the
// observed LLM slip repaired — a duplicated closing quote at an element
// boundary (`"," "` where `", "` was meant; byte-exact from the run:
// `tests."," "BRIEF` where `tests.", "BRIEF` was intended), which makes
// JSON.parse fail mid-array even though the payload is otherwise complete.
//
// Repair 2 (T-040 lane review round 1; red bar recorded from real run
// 20261022211937's planner-r2-raw.txt — the driving Gate 2 red, teed at
// C:\swarm\verify-red\T-040-gate2-full.log): the ROUND-2 planner — prompted
// with the composed survivor-evidence block — answered with a complete
// two-brief array of `{"brief": "<text>"}` OBJECTS instead of an array of
// strings, and repeated the exact shape on its bounded repair attempt; the
// plain scan's element filter dropped every object, the array scanned empty,
// and both planner attempts fell back to the raw goal. When both scans above
// return null, a third scan looks for a [..] slice parsing to an array whose
// EVERY element is an object carrying its own non-empty string `brief`, and
// returns those strings — the model's own labeled briefs, READ out of the
// payload, never fabricated and never rewritten; any other shape stays null.
// Same inertness contract as repair 1: structurally unreachable while either
// existing scan parses. Gate 0.5 pins both repairs and the recorded fixture
// (scripts/fixtures/planner-r2-objects-raw.txt).

/** The one observed separator slip, repaired only as a last resort. */
function repairBriefSeparators(text: string): string {
  return text.replace(/","\s+"/g, '","')
}

export function parseBriefs(text: string, count: number): string[] | null {
  return scanBriefs(text, count)
    ?? scanBriefs(repairBriefSeparators(text), count)
    ?? scanBriefObjects(text, count)
}

function scanBriefs(text: string, count: number): string[] | null {
  const lastBracket = text.lastIndexOf(']')
  if (lastBracket === -1) return null
  for (let i = lastBracket; i >= 0; i--) {
    if (text[i] === '[') {
      try {
        const parsed: unknown = JSON.parse(text.slice(i, lastBracket + 1))
        if (!Array.isArray(parsed)) continue
        const briefs = parsed
          .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
          .map((b) => b.trim())
        if (briefs.length === 0) continue
        // T-056 exact-count: a slice whose valid-brief count is not exactly
        // the requested count is not a payload — skip it like any invalid
        // slice (the all-or-nothing rule's exact-count clause). The deleted
        // pad/truncate tail lived exactly here.
        if (briefs.length !== count) continue
        return briefs
      } catch {
        // Try the next '[' to the left.
      }
    }
  }
  return null
}

/** Repair 2's scan: the recorded objects-shape slip, READ as a last resort.
 *  Mirrors scanBriefs' prose-tolerant bracket scan; a candidate slice parses
 *  only when its EVERY element is an object carrying a non-empty string
 *  `brief` — the all-or-nothing rule that keeps the repair from fabricating
 *  briefs (one bad element sinks the slice). The exact-count clause is
 *  scanBriefs' verbatim (T-056). */
function scanBriefObjects(text: string, count: number): string[] | null {
  const lastBracket = text.lastIndexOf(']')
  if (lastBracket === -1) return null
  for (let i = lastBracket; i >= 0; i--) {
    if (text[i] === '[') {
      try {
        const parsed: unknown = JSON.parse(text.slice(i, lastBracket + 1))
        if (!Array.isArray(parsed) || parsed.length === 0) continue
        if (!parsed.every((el) => typeof el === 'object' && el !== null
          && 'brief' in el
          && typeof (el as Record<string, unknown>).brief === 'string'
          && ((el as Record<string, unknown>).brief as string).trim().length > 0)) continue
        const briefs = parsed.map((el) => ((el as Record<string, unknown>).brief as string).trim())
        // T-056 exact-count — scanBriefs' clause, verbatim.
        if (briefs.length !== count) continue
        return briefs
      } catch {
        // Try the next '[' to the left.
      }
    }
  }
  return null
}

export const REVIEW_SEVERITIES = ['info', 'concern', 'blocker-advisory'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

export interface ParsedReview {
  observations: { finding: string; severity: ReviewSeverity; evidence?: string }[]
}

/** Validate a reviewer JSON payload: {observations: [{finding, severity, evidence?}]}. */
export function parseReview(text: string): ParsedReview | null {
  const lastBrace = text.lastIndexOf('}')
  if (lastBrace === -1) return null
  for (let i = lastBrace; i >= 0; i--) {
    if (text[i] === '{') {
      try {
        const parsed: unknown = JSON.parse(text.slice(i, lastBrace + 1))
        if (typeof parsed !== 'object' || parsed === null || !('observations' in parsed)) continue
        const raw = (parsed as { observations: unknown }).observations
        if (!Array.isArray(raw) || raw.length === 0) continue
        const observations: ParsedReview['observations'] = []
        let shapeOk = true
        for (const o of raw) {
          if (typeof o !== 'object' || o === null) { shapeOk = false; break }
          const { finding, severity, evidence } = o as Record<string, unknown>
          if (typeof finding !== 'string' || finding.trim().length === 0) { shapeOk = false; break }
          if (typeof severity !== 'string' || !REVIEW_SEVERITIES.includes(severity as ReviewSeverity)) { shapeOk = false; break }
          if (evidence !== undefined && typeof evidence !== 'string') { shapeOk = false; break }
          observations.push({
            finding: finding.trim(),
            severity: severity as ReviewSeverity,
            ...(typeof evidence === 'string' && evidence.trim().length > 0 ? { evidence: evidence.trim() } : {}),
          })
        }
        if (shapeOk) return { observations }
      } catch {
        // Try the next '{' to the left.
      }
    }
  }
  return null
}
