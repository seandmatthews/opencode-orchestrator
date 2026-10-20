// Parser contract self-check (Gate 0.5, fast tier) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-parse.mjs
// Pins the structured-output extraction rules without spending model tokens.
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
t('short array cycles to fill count', JSON.stringify(parseBriefs('["a"]', 3)) === '["a","a","a"]')
t('long array truncates to count', parseBriefs('["a","b","c","d"]', 2)?.length === 2)
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
