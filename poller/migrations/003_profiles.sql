-- The learned profile.
--
-- `day_type` and `bucket` of -1 mean "pooled at this level" -- that is what makes one
-- table hold every rung of the shrinkage ladder rather than one table per rung.
--
-- These are the durable artefact. The observation table above is replay convenience; if
-- it were lost, three months of learning would still be here.

CREATE TABLE IF NOT EXISTS segment_profile (
  agency        text     NOT NULL,
  route_id      text     NOT NULL,
  direction_id  smallint NOT NULL,
  segment_key   text     NOT NULL,
  day_type      smallint NOT NULL,
  bucket        smallint NOT NULL,

  n             double precision NOT NULL DEFAULT 0,
  mean          double precision NOT NULL DEFAULT 0,
  m2            double precision NOT NULL DEFAULT 0,

  -- Decayed sufficient statistics for delta ~ a + b * prior_deviation. b is the
  -- interesting one: negative is a recovery segment eating schedule slack, positive is a
  -- late bus meeting a bigger crowd at every stop and falling further behind.
  reg_w         double precision NOT NULL DEFAULT 0,
  reg_sx        double precision NOT NULL DEFAULT 0,
  reg_sy        double precision NOT NULL DEFAULT 0,
  reg_sxx       double precision NOT NULL DEFAULT 0,
  reg_sxy       double precision NOT NULL DEFAULT 0,

  -- Kept so a timetable change can re-base the cell instead of discarding it.
  scheduled_run integer NOT NULL DEFAULT 0,
  noise_var     double precision NOT NULL DEFAULT 0,

  -- Only populated where day_type is set and bucket is -1. Tail *shape* is a property of
  -- a segment and a day type; it does not vary meaningfully between adjacent half hours,
  -- and storing it per bucket would be a gigabyte of noise.
  histogram     real[],

  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, route_id, direction_id, segment_key, day_type, bucket)
);

CREATE INDEX IF NOT EXISTS segment_profile_route
  ON segment_profile (agency, route_id, direction_id, day_type);

-- The same physical hop run by any route. Held as a rate, so a thin route can borrow a
-- busy one's evidence without inheriting its segment lengths.
CREATE TABLE IF NOT EXISTS corridor_profile (
  agency       text     NOT NULL,
  corridor_key text     NOT NULL,
  day_type     smallint NOT NULL,
  bucket       smallint NOT NULL,
  n            double precision NOT NULL DEFAULT 0,
  mean         double precision NOT NULL DEFAULT 0,
  m2           double precision NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, corridor_key, day_type, bucket)
);

CREATE TABLE IF NOT EXISTS route_profile (
  agency       text     NOT NULL,
  route_id     text     NOT NULL,
  direction_id smallint NOT NULL,
  day_type     smallint NOT NULL,
  bucket       smallint NOT NULL,
  n            double precision NOT NULL DEFAULT 0,
  mean         double precision NOT NULL DEFAULT 0,
  m2           double precision NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, route_id, direction_id, day_type, bucket)
);

CREATE TABLE IF NOT EXISTS agency_profile (
  agency     text     NOT NULL,
  day_type   smallint NOT NULL,
  bucket     smallint NOT NULL,
  n          double precision NOT NULL DEFAULT 0,
  mean       double precision NOT NULL DEFAULT 0,
  m2         double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, day_type, bucket)
);

-- How late a trip leaves its origin. A garage property, not a traffic one, and the entire
-- prediction for a trip that has not started yet.
CREATE TABLE IF NOT EXISTS start_profile (
  agency       text     NOT NULL,
  route_id     text     NOT NULL,
  direction_id smallint NOT NULL,
  day_type     smallint NOT NULL,
  bucket       smallint NOT NULL,
  n            double precision NOT NULL DEFAULT 0,
  mean         double precision NOT NULL DEFAULT 0,
  m2           double precision NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, route_id, direction_id, day_type, bucket)
);

-- How wrong the agency's own predictions are, by how far out they were made.
--
-- Trained only from observation tiers that are independent of the prediction being
-- graded. Training this from "the last thing the predictor said before it went quiet"
-- would measure how fast a predictor converges on itself, which is not accuracy.
CREATE TABLE IF NOT EXISTS prediction_error (
  agency       text     NOT NULL,
  route_id     text     NOT NULL,
  direction_id smallint NOT NULL,
  horizon      integer  NOT NULL,
  day_type     smallint NOT NULL,
  bucket       smallint NOT NULL,
  n            double precision NOT NULL DEFAULT 0,
  mean         double precision NOT NULL DEFAULT 0,
  m2           double precision NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, route_id, direction_id, horizon, day_type, bucket)
);

-- The offset between an inferred observation and a measured one, per agency and period.
-- Until this exists for an agency, that agency's inferred observations are held at the
-- wider uncertainty and kept out of the prediction-error model entirely.
CREATE TABLE IF NOT EXISTS tier_calibration (
  agency     text     NOT NULL,
  period     smallint NOT NULL,
  n          double precision NOT NULL DEFAULT 0,
  offset_s   double precision NOT NULL DEFAULT 0,
  variance   double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, period)
);

-- The scoreboard. Raw against corrected, every day, by agency and horizon.
--
-- Coverage is the column people skip and the one that matters most: a band that contains
-- the truth half the time is a worse failure than a point estimate that is merely off,
-- because it is the one that gets believed.
CREATE TABLE IF NOT EXISTS model_score (
  day          date     NOT NULL,
  agency       text     NOT NULL,
  horizon      integer  NOT NULL,
  n            integer  NOT NULL DEFAULT 0,
  raw_mae      double precision,
  raw_median   double precision,
  corr_mae     double precision,
  corr_median  double precision,
  bias         double precision,
  coverage     double precision,
  win_rate     double precision,
  PRIMARY KEY (day, agency, horizon)
);
