-- Keep signed execution nonces past the full timestamp acceptance window.
-- 0068 is already merged; preserve its bytes and correct the function forward.
CREATE OR REPLACE FUNCTION public.claim_omni_execution_nonce(_client text,_nonce text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE prefix text := 'execution:'||_client||':';
BEGIN
  IF _client IS NULL OR _client !~ '^[A-Za-z0-9_-]{1,64}$'
    OR _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
  THEN RAISE EXCEPTION 'Invalid execution nonce'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(prefix,0));
  DELETE FROM public.omni_callback_nonces WHERE nonce LIKE 'execution:%'
    AND received_at<now()-interval '5 minutes';
  IF (SELECT count(*) FROM public.omni_callback_nonces
      WHERE left(nonce,length(prefix))=prefix
      AND received_at>=now()-interval '60 seconds')>=400
  THEN RAISE EXCEPTION 'Execution request rate exceeded'; END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES(prefix||_nonce);
END $$;
