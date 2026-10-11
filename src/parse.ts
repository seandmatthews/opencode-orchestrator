// Pure extraction/validation helpers for structured model output.
// Inputs are assumed ANSI-stripped (the worker adapter does that); parsers
// scan for the last JSON payload in prose so surrounding chatter is tolerated.

export function parseBriefs(text: string, count: number): string[] | null {
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
        const original = briefs.length
        while (briefs.length < count) briefs.push(briefs[briefs.length % original]!)
        return briefs.slice(0, count)
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
