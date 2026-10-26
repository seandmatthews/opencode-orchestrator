// Parser contract self-check (Gate 0.5, fast tier) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-parse.mjs
// Pins the structured-output extraction rules without spending model tokens.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBriefs, parseReview } from '../src/parse.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

// parseBriefs
t('plain array passes through', JSON.stringify(parseBriefs('["a","b"]', 2)) === '["a","b"]')
t('array embedded in prose is found', parseBriefs('Sure! Here you go: ["a"] hope that helps', 1)?.[0] === 'a')
t('scan survives a stray bracket in prose', parseBriefs('options [see docs] then ["a","b"]', 2)?.[1] === 'b')
// T-056 (brief-count honesty): the two pins below asserted the pad/truncate
// tail and were REPLACED with the exact-count expectation — strengthened, not
// weakened (the T-044 precedent; reasoning recorded here and in VERIFICATION.md
// Gate 0.5). On main, parseBriefs('["a"]', 3) returned '["a","a","a"]' (cyclic
// padding) and parseBriefs('["a","b","c","d"]', 2) returned 2 (silent
// truncation) — the recorded red bar (asserted against main's parse.ts before
// this change-set; also pinned in the ticket shapes by Gate 1.42). A reply
// whose valid-brief count is not exactly the requested count is now a parse
// failure: the scan skips the slice (the all-or-nothing rule's exact-count
// clause), the planner's bounded repair runs, and the raw-goal fallback
// records the failure loudly — same tokens, honest provenance, instead of one
// brief masquerading as N distinct briefs (adversarial review R9).
t('count-mismatch is a parse failure: a SHORT array is no longer cyclically padded — 1 brief for count 3 parses null (was ["a","a","a"] on main, the recorded red bar)',
  parseBriefs('["a"]', 3) === null)
t('count-mismatch is a parse failure: a LONG array is no longer truncated — 4 briefs for count 2 parses null (was 2 on main, the recorded red bar)',
  parseBriefs('["a","b","c","d"]', 2) === null)
t('exactly-N arrays are untouched byte-for-byte (the inertness contract\'s narrowed scope — the preserved case, T-056)',
  JSON.stringify(parseBriefs('["a","b"]', 2)) === '["a","b"]'
  && JSON.stringify(parseBriefs('[" x ","y "]', 2)) === JSON.stringify(['x', 'y'])
  && parseBriefs('[1,{"x":2},"a"]', 1)?.length === 1)
t('non-string elements filtered', parseBriefs('[1,{"x":2},"a"]', 1)?.[0] === 'a')
t('no json at all returns null', parseBriefs('no json here', 1) === null)
t('empty strings rejected', parseBriefs('["", "  "]', 1) === null)

// T-029 review round 1 — the last-resort separator repair. Red bar recorded
// from real run 20261020053845 (the driving Gate 2, 2026-10-20): the
// planner's attempt-2 array was complete but ONE element boundary carried a
// duplicated closing quote — `...ends."," "next...` where
// `...ends.", "next...` was meant — so JSON.parse failed mid-array
// ("Expected ',' or ']' after array element"), parseBriefs returned null,
// and BOTH planner attempts fell back to the raw goal. (Attempt 1 had
// produced no array at all: the plan agent's exploration was derailed by
// auto-rejected external_directory permissions — VERIFICATION.md Known
// issue #6.) The capture also carried OpenCode's final frame after the
// array (`\r\n\r\n> plan · glm-5.3\r\n\r\n`) — chatter the scan already
// tolerates, kept in the fixture for faithfulness to the recorded bytes.
const separated = '["first brief ends here."," "second brief has [brackets] inside"]\r\n\r\n> plan · glm-5.3\r\n\r\n'
t('separator repair: the recorded duplicated-quote boundary now yields both briefs (run 20261020053845 red bar, green bar)',
  JSON.stringify(parseBriefs(separated, 2))
    === JSON.stringify(['first brief ends here.', 'second brief has [brackets] inside']))
t('separator repair is inert whenever the plain scan parses: valid input whose string CONTENT contains the slip pattern parses untouched',
  parseBriefs('["a content \\",\\" b"]', 1)?.[0] === 'a content "," b')
t('separator repair does not fabricate briefs from hopeless input', parseBriefs('"," "no array here', 1) === null)

// T-040 lane review round 1 — the last-resort objects-shape extraction (the
// third resort, after the plain scan and the separator repair). Red bar
// recorded from real run 20261022211937 (the driving Gate 2, 2026-10-22,
// teed at C:\swarm\verify-red\T-040-gate2-full.log): the ROUND-2 planner —
// prompted with the composed survivor-evidence block — answered with a
// complete two-brief array of `{"brief": "<text>"}` OBJECTS instead of an
// array of strings, and repeated the exact shape on its bounded repair
// attempt. parseBriefs' element filter drops non-strings, the array scanned
// empty, and BOTH planner attempts fell back to the raw goal (the runner
// logged `planner (round 2): no valid output, using raw goal in 115s (2
// attempts)`), which turned Gate 2's two planner assertions red. The
// recorded bytes are vendored byte-for-byte at
// scripts/fixtures/planner-r2-objects-raw.txt (6543 bytes, OpenCode's final
// frame included — the T-029 fixture faithfulness rule). The extraction
// reads the model's OWN labeled briefs — it never fabricates one: every
// element of the parsed slice must be an object carrying its own non-empty
// string `brief`, else the candidate slice is skipped. The resort runs only
// when BOTH existing scans return null, so it stays structurally unreachable
// while either scan parses (pinned below, the T-029 inertness pattern).
// Since T-056 the scans' exact-count clause deliberately narrows the older
// byte-identity claim: every EXACTLY-COUNT input that parsed before parses
// byte-identically; a count-mismatched reply now parses null through every
// scan (see the T-056 pins above and VERIFICATION.md Gate 0.5).
const objectsRaw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'planner-r2-objects-raw.txt'), 'utf8')
const objectsBriefs = parseBriefs(objectsRaw, 2)
t('objects repair: the recorded round-2 planner payload yields exactly 2 briefs (run 20261022211937 red bar, green bar)',
  Array.isArray(objectsBriefs) && objectsBriefs.length === 2
  && objectsBriefs[0]?.startsWith('Brief A - ') && objectsBriefs[1]?.startsWith('Brief B - '))
t('objects repair: the briefs are the model\'s own bytes, read out of the recorded payload — never fabricated',
  objectsBriefs?.every((b) => objectsRaw.includes(b)) === true
  && objectsBriefs?.[0] !== objectsBriefs?.[1])
// T-056: this pin asserted the objects scan's pad/truncate tail (scanBriefs'
// verbatim) and is REPLACED with the exact-count expectation — strengthened,
// not weakened (the T-044 precedent): both shapes are now parse failures that
// flow to the planner's bounded repair and the raw-goal fallback, instead of
// one object brief riding N candidates (the strings-scan red bar above; Gate
// 1.42 pins the preserved exactly-N case and the fallback end to end).
t('objects repair: count-mismatched payloads parse null — 1 brief for count 3 no longer cycles (was ["only one" x3] on main) and 3 briefs for count 2 no longer truncate (was ["a","b"] on main)',
  parseBriefs('[{"brief":"only one"}]', 3) === null
  && parseBriefs('[{"brief":"a"},{"brief":"b"},{"brief":"c"}]', 2) === null)
t('objects repair never fabricates: missing/non-string/empty brief values and empty arrays all stay null',
  parseBriefs('[{"text":"no brief key"}]', 1) === null
  && parseBriefs('[{"brief":"a"},{"brief":42}]', 1) === null
  && parseBriefs('[{"brief":"  "}]', 1) === null
  && parseBriefs('[{"brief":"a"},1]', 1) === null
  && parseBriefs('[{"brief":null}]', 1) === null
  && parseBriefs('[]', 1) === null)
t('objects repair is a LAST resort: a mixed object+string array keeps parsing through the PLAIN path (the existing filter semantics, unchanged — the resort never fires)',
  parseBriefs('[{"brief":"a"},"plain string"]', 1)?.[0] === 'plain string')
t('objects repair is a LAST resort: valid string arrays whose string CONTENT embeds the objects pattern parse byte-identically through the plain path',
  parseBriefs('["a {\\"brief\\": \\"fake\\"} b","c"]', 2)?.[0] === 'a {"brief": "fake"} b'
  && parseBriefs('["a {\\"brief\\": \\"fake\\"} b","c"]', 2)?.[1] === 'c')
t('objects repair tolerates the recorded frame: the fixture\'s trailing OpenCode footer and in-brief brackets do not derail the scan',
  objectsBriefs?.[1]?.includes('crosswindComponent') === true)

// parseReview
const good = '{"observations":[{"finding":"f","severity":"concern"},{"finding":"g","severity":"info","evidence":"diff"}]}'
t('valid review object parses', parseReview(good)?.observations.length === 2)
t('review embedded in prose is found', parseReview(`here: ${good} done`)?.observations.length === 2)
t('bad severity rejected', parseReview('{"observations":[{"finding":"f","severity":"huge"}]}') === null)
t('empty observations rejected', parseReview('{"observations":[]}') === null)
t('missing observations rejected', parseReview('{"findings":[]}') === null)
t('empty finding rejected', parseReview('{"observations":[{"finding":"  ","severity":"info"}]}') === null)
t('non-string evidence rejected', parseReview('{"observations":[{"finding":"f","severity":"info","evidence":3}]}') === null)
t('non-object payload rejected', parseReview('["just an array"]') === null)
t('findings are trimmed', parseReview('{"observations":[{"finding":"  spaced  ","severity":"info"}]}')?.observations[0]?.finding === 'spaced')

if (failures.length > 0) {
  console.error(`\ncheck-parse: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-parse: ALL GREEN')
