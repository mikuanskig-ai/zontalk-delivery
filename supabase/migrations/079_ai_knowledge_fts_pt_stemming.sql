-- ============================================================
-- 079_ai_knowledge_fts_pt_stemming.sql — fix AI knowledge-base lexical
-- retrieval missing real, indexed answers (RAG recall bug)
--
-- Confirmed live (Concórdia, 2026-09-13, reported by Eder — "ela
-- alucinou mesmo"): a customer asked "quanto e por pessoa pro almoço
-- no domingo" and the AI answered R$70/R$35 with an invented "massas
-- de macarrão incluso" — the account's real, correctly-indexed KB
-- document says R$84,90/R$42,45 with caipirinha+refrigerante à
-- vontade, no macarrão. The model didn't misread its context; it
-- never got the right chunk in its context to begin with. Root-caused
-- to two compounding bugs in migration 030's lexical (FTS) retrieval
-- path — the only path this account has, since it has no embeddings
-- key configured (semantic search is optional/paid):
--
--   1. `plainto_tsquery` ANDs every word in the query. A customer's
--      natural sentence ("Gostaria de saber quanto e por pessoa pro
--      almoço no domingo") essentially never has ALL of its words
--      present verbatim in one short indexed chunk — reproduced live,
--      this exact message returned ZERO rows, not just a wrong one.
--   2. The stored `fts` column uses the `'simple'` text search config
--      (chosen deliberately in 030 for language-neutral support across
--      wacrm's BR/LATAM/IN markets) — but `'simple'` has no stemming,
--      so "domingo" (customer's word) and "Domingos" (the KB's plural,
--      "Domingos: R$ 84,90...") are different lexemes and never match,
--      even in isolation.
--
-- Fix, both language-neutral-safe (additive, not replacing the
-- existing behavior any account already relies on):
--   - The generated `fts` column now concatenates the `'simple'`
--     tsvector (kept, unchanged, exact literal-token matching — still
--     works identically for every non-Portuguese account) WITH a
--     `'portuguese'` tsvector of the same content (stemming so
--     domingo/Domingos/pessoa/pessoas etc. collapse to the same
--     lexeme). tsvector `||` concatenation is a plain union of lexeme
--     sets with positions offset — additive, never fewer matches than
--     before.
--   - `match_ai_knowledge_fts` no longer ANDs the raw query. It now
--     extracts the query's own lexemes under BOTH configs and ORs them
--     into one tsquery (`a | b | c | ...`) — any single matching word
--     surfaces a chunk, ranked by how many/how well terms match via
--     ts_rank (unchanged ranking function), instead of requiring every
--     query word present in the same chunk.
--
-- Dropping+re-adding the generated column recomputes it for every
-- existing row automatically (Postgres requirement for altering a
-- STORED generated column's expression — there is no ALTER ... SET
-- EXPRESSION). Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_knowledge_chunks DROP COLUMN IF EXISTS fts;

ALTER TABLE ai_knowledge_chunks
  ADD COLUMN fts tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', content) || to_tsvector('portuguese', content)
  ) STORED;

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_fts_idx
  ON ai_knowledge_chunks USING gin (fts);

-- Builds an OR-joined tsquery from every distinct lexeme `p_query`
-- produces under both configs — e.g. "domingo" contributes both
-- 'domingo' (simple) and 'doming' (portuguese stem), matching a chunk
-- indexed with either form. Returns NULL (never errors) when the query
-- is empty/all-stopwords under both configs, e.g. "" or "de o a" —
-- callers already treat "no rows" as "no KB hit", same as before.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH lexemes AS (
    SELECT lexeme FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lexeme
    UNION
    SELECT lexeme FROM unnest(tsvector_to_array(to_tsvector('portuguese', p_query))) AS lexeme
  ),
  query AS (
    SELECT to_tsquery('simple', string_agg(lexeme, ' | ')) AS tsq FROM lexemes
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, query.tsq) AS rank
  FROM ai_knowledge_chunks c, query
  WHERE c.account_id = p_account_id
    AND query.tsq IS NOT NULL
    AND c.fts @@ query.tsq
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
