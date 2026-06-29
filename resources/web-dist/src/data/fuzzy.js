// Tiny fuzzy subsequence matcher for the quick-add palette. Pure, no DOM.
//
// fuzzyMatch(query, text) returns { score, positions } when every character of
// `query` appears in `text` in order, or null otherwise. Higher score = better:
// consecutive runs and matches at word boundaries (start, or after a space / -
// _ / . / ( /) are rewarded, and shorter / earlier matches are preferred. The
// returned `positions` are the matched character indices (for highlighting).
//
// This is deliberately the only ranking knowledge in one place — a future
// semantic / RAG ranker can replace it behind the same {score, positions} shape.
const BOUNDARY = /[\s\-_/.()|]/;

export function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const positions = [];
  let qi = 0, score = 0, run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const atBoundary = ti === 0 || BOUNDARY.test(t[ti - 1]);
      score += 1 + run * 3 + (atBoundary ? 6 : 0);
      positions.push(ti);
      run++; qi++;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return null;        // not all query chars consumed
  score -= text.length * 0.02;           // prefer concise labels
  score -= positions[0] * 0.1;           // prefer an earlier first match
  return { score, positions };
}
