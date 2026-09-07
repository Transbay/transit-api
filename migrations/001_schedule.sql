-- The static half of the feed: what a trip is supposed to do.
--
-- One row per trip, with the stop sequence held as parallel arrays rather than as a
-- stop_times table. The read pattern is always "give me this whole trip" -- nothing ever
-- asks for one stop time in isolation -- and a normalised table would be four hundred
-- thousand rows per feed version to answer a query that is naturally one row.

CREATE TABLE IF NOT EXISTS feed_version (
  id          bigserial PRIMARY KEY,
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  agencies    text[]      NOT NULL,
  trips       integer     NOT NULL DEFAULT 0,
  stop_times  integer     NOT NULL DEFAULT 0,
  -- Several versions are kept live at once, deliberately. When 511 ships a service change
  -- the realtime feed moves hours before the archive we mirror does, and trips appear that
  -- the newest static tables have never heard of. Resolving against whichever version
  -- knows a trip is the difference between four dark days a year and none.
  active      boolean     NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS scheduled_trip (
  feed_version bigint    NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
  agency       text      NOT NULL,
  trip_id      text      NOT NULL,
  route_id     text      NOT NULL,
  direction_id smallint  NOT NULL DEFAULT 0,
  pattern_id   text      NOT NULL,
  service_id   text      NOT NULL,
  block_id     text      NOT NULL DEFAULT '',
  short_name   text      NOT NULL DEFAULT '',
  -- Seconds into the service day, so a 25:12 trip is 90720 and never a broken timestamp.
  start_s      integer   NOT NULL,
  stop_ids     text[]    NOT NULL,
  seqs         integer[] NOT NULL,
  arrivals     integer[] NOT NULL,
  departures   integer[] NOT NULL,
  timepoints   boolean[] NOT NULL,
  PRIMARY KEY (feed_version, trip_id)
);

CREATE INDEX IF NOT EXISTS scheduled_trip_service
  ON scheduled_trip (feed_version, agency, service_id);

-- calendar.txt and calendar_dates.txt, expanded. "Which trips run today" is a lookup, and
-- "is today unlike this weekday usually is" -- the holiday test -- is a comparison.
CREATE TABLE IF NOT EXISTS service_day (
  feed_version bigint NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
  agency       text   NOT NULL,
  service_id   text   NOT NULL,
  day          date   NOT NULL,
  PRIMARY KEY (feed_version, service_id, day)
);

CREATE INDEX IF NOT EXISTS service_day_by_day ON service_day (feed_version, day);
