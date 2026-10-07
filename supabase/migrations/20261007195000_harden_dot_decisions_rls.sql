-- Harden DOT decisions access control.
-- The Filtra.AI API uses a trusted PostgreSQL connection; browser/Data API roles
-- must not be able to read or mutate DOT decision records.

ALTER TABLE public.dot_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dot_decisions_deny_anon ON public.dot_decisions;
DROP POLICY IF EXISTS dot_decisions_deny_authenticated ON public.dot_decisions;

CREATE POLICY dot_decisions_deny_anon
  ON public.dot_decisions
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY dot_decisions_deny_authenticated
  ON public.dot_decisions
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.dot_decisions FROM anon, authenticated;
