export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens = new Set<string>()

  // Word tokens for Latin/ASCII text (min 2 chars)
  for (const word of normalized.match(/[a-zÀ-ɏ0-9]{2,}/g) ?? []) {
    tokens.add(word)
  }

  // Character bigrams for all text — handles CJK/Japanese natively without a tokenizer
  for (let i = 0; i < normalized.length - 1; i++) {
    const a = normalized[i]
    const b = normalized[i + 1]
    if (a.trim() === '' || b.trim() === '') continue
    if (/[.,!?;:"'()\[\]{}\-_/\\|@#$%^&*+=~`<>。、！？；：「」『』【】（）]/.test(a)) continue
    if (/[.,!?;:"'()\[\]{}\-_/\\|@#$%^&*+=~`<>。、！？；：「」『』【】（）]/.test(b)) continue
    tokens.add(a + b)
  }

  return [...tokens]
}

export interface TfIdfDoc {
  date: string
  content: string
}

export interface TfIdfIndex {
  vectors: Map<string, Map<string, number>>  // date → (token → normalized tf-idf)
  contents: Map<string, string>              // date → raw content for snippet extraction
}

export function buildIndex(docs: TfIdfDoc[]): TfIdfIndex {
  const N = docs.length
  if (N === 0) return { vectors: new Map(), contents: new Map() }

  // Step 1: tokenize each doc and count term frequencies
  // Store both the raw token count (with duplicates) for TF normalization
  // and a Map of counts per unique token.
  const docTermCounts = docs.map(doc => {
    const tokens = tokenize(doc.content)
    const counts = new Map<string, number>()
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
    return { counts, totalTokens: tokens.length || 1 }
  })

  // Step 2: document frequency — how many docs contain each token
  const df = new Map<string, number>()
  for (const { counts } of docTermCounts) {
    for (const token of counts.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }

  // Step 3: compute TF-IDF scores and L2-normalize each vector for cosine similarity
  const vectors = new Map<string, Map<string, number>>()
  const contents = new Map<string, string>()

  docs.forEach((doc, i) => {
    const { counts, totalTokens } = docTermCounts[i]
    const vec = new Map<string, number>()
    let normSq = 0

    counts.forEach((count, token) => {
      const tf = count / totalTokens
      // Smoothed IDF avoids division by zero and dampens extremely common tokens
      const idf = Math.log((N + 1) / (df.get(token)! + 1)) + 1
      const score = tf * idf
      vec.set(token, score)
      normSq += score * score
    })

    const norm = Math.sqrt(normSq)
    if (norm > 0) vec.forEach((v, k) => vec.set(k, v / norm))

    vectors.set(doc.date, vec)
    contents.set(doc.date, doc.content)
  })

  return { vectors, contents }
}

export interface SearchHit {
  date: string
  score: number
  snippet: string
}

export function search(index: TfIdfIndex, query: string, limit = 20): SearchHit[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || index.vectors.size === 0) return []

  const scores: { date: string; score: number }[] = []

  index.vectors.forEach((vec, date) => {
    let score = 0
    for (const token of queryTokens) {
      const s = vec.get(token)
      if (s) score += s
    }
    if (score > 0) scores.push({ date, score })
  })

  scores.sort((a, b) => b.score - a.score)

  return scores.slice(0, limit).map(({ date, score }) => ({
    date,
    score,
    snippet: extractSnippet(index.contents.get(date) ?? '', queryTokens),
  }))
}

export function findSimilar(index: TfIdfIndex, date: string, limit = 5): string[] {
  const vec = index.vectors.get(date)
  if (!vec || index.vectors.size <= 1) return []

  const scores: { date: string; score: number }[] = []

  index.vectors.forEach((otherVec, otherDate) => {
    if (otherDate === date) return
    // Dot product of L2-normalized vectors = cosine similarity
    let dot = 0
    vec.forEach((v, token) => {
      const ov = otherVec.get(token)
      if (ov) dot += v * ov
    })
    if (dot > 0) scores.push({ date: otherDate, score: dot })
  })

  scores.sort((a, b) => b.score - a.score)
  return scores.slice(0, limit).map(s => s.date)
}

function extractSnippet(content: string, queryTokens: string[], maxLen = 120): string {
  const normalized = content.normalize('NFKC').toLowerCase()
  let bestIdx = -1

  for (const token of queryTokens) {
    const idx = normalized.indexOf(token)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx
  }

  const start = bestIdx === -1 ? 0 : Math.max(0, bestIdx - 40)
  return content.slice(start, start + maxLen).replace(/\n/g, ' ')
}
