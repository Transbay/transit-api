-- Spot checks: a random prediction, and what the vehicle then actually did.
--
-- One row per check. "Actual" is the agency's last departure time for that trip at that
-- stop before it left the feed -- the best the feed ever knew. Rolled up into `model_score`
-- by agency and horizon, which is what `/v1/profile/scores` reads and what decides whether
-- a correction is proven enough to show.
CREATE TABLE IF NOT EXISTS accuracy_check (
  id          bigserial PRIMARY KEY,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  agency      text        NOT NULL,
  stop_id     text        NOT NULL,
  trip_id     text        NOT NULL,
  line_ref    text        NOT NULL DEFAULT '',
  made_at     timestamptz NOT NULL,
  -- Seconds from the prediction to the actual departure.
  horizon_s   integer     NOT NULL,
  -- Signed seconds, positive when the prediction was late (said later than it happened).
  raw_error   integer     NOT NULL,
  model_error integer     NOT NULL,
  in_band     boolean     NOT NULL,
  samples     double precision NOT NULL DEFAULT 0,
  confidence  text        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS accuracy_check_day ON accuracy_check (checked_at);
