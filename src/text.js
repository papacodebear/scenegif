const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'he', 'her', 'his',
  'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their',
  'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'who', 'with', 'you', 'your',
  'scene', 'clip', 'movie', 'film',
]);

// Lowercased content words, minus stopwords and one-letter noise.
export function terms(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9']+/g) || [])
    .map(w => w.replace(/'s?$/, ''))
    .filter(w => w.length > 1 && !STOPWORDS.has(w)));
}

// Prefix match stands in for stemming: cut/cutting, thread/threads, fate/fates.
function related(a, b) {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

// Count of query terms that appear in the candidate terms.
export function termOverlap(queryTerms, candidateTerms) {
  let n = 0;
  for (const q of queryTerms) if ([...candidateTerms].some(c => related(q, c))) n++;
  return n;
}
