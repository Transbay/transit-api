-- Which stops actually hold.
--
-- `timepoint = 1` says a hold is *possible*. It does not say one happens, and on this feed
-- it frequently says nothing at all: BART and Caltrain flag 100% of their stops. Even on an
-- operator that flags selectively, some flagged stops hold and some are just published
-- times that nobody waits for -- a terminal holds, a downtown timepoint on a busy line
-- usually cannot afford to.
--
-- So it is measured per stop rather than assumed. `n` counts occasions a vehicle arrived
-- materially early (the only occasions on which holding is observable at all) and `mean` is
-- the fraction of those on which it left on time anyway.
--
-- Deliberately shaped like the other moment tables so it shares their read-modify-write
-- path: a 0/1 indicator's decayed mean is exactly the rate we want, and it forgets a
-- retimed stop at the same rate everything else does.
CREATE TABLE IF NOT EXISTS stop_hold_profile (
  agency       text     NOT NULL,
  route_id     text     NOT NULL,
  direction_id smallint NOT NULL,
  stop_id      text     NOT NULL,
  n            double precision NOT NULL DEFAULT 0,
  mean         double precision NOT NULL DEFAULT 0,
  m2           double precision NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, route_id, direction_id, stop_id)
);

CREATE INDEX IF NOT EXISTS stop_hold_profile_route
  ON stop_hold_profile (agency, route_id, direction_id);
