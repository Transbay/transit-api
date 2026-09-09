-- Separate the two things `prediction_error` measures.
--
-- The table was written for one quantity: `actual - predicted`, the agency's real error at
-- a horizon, measured against an observed passage. That needs the observation pipeline, so
-- it exists only for the profiled agencies.
--
-- `drift.ts` now folds a second quantity into the same shape: `predFinal - predAtHorizon`,
-- how far a producer's own estimate moves as the arrival closes. That one needs no
-- schedule and so covers every operator in the feed.
--
-- They are not the same measurement and must never be averaged together. Drift is
-- self-referential -- it grades a predictor against its own last word, which says how fast
-- it converges and nothing about whether it converged on the truth. Measured error is
-- ground truth. Folding both into one cell would produce a number that is neither, with no
-- symptom: the mean would simply drift toward whichever source happened to be louder on
-- that route, and every correction downstream would inherit it.
--
-- So the source becomes part of the key. That also makes the calibration check possible:
-- for the five agencies that have both, the two rows should agree, and if they ever stop
-- agreeing the drift measurement is the one to distrust.

ALTER TABLE prediction_error ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'drift';

-- Rebuild the primary key to include it. Existing rows are all drift -- the observed path
-- has never written here, because the estimator that reads it was never wired up.
ALTER TABLE prediction_error DROP CONSTRAINT IF EXISTS prediction_error_pkey;
ALTER TABLE prediction_error
  ADD PRIMARY KEY (source, agency, route_id, direction_id, horizon, day_type, bucket);

-- The prediction path asks for one source at a time, across every route of an agency.
CREATE INDEX IF NOT EXISTS prediction_error_source_agency
  ON prediction_error (source, agency);
