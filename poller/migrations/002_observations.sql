-- What actually happened, one row per trip-instance.
--
-- The obvious schema is a row per stop event: 300,000 a day, 27 million a quarter, and
-- with two indexes it costs more in index than in data. But nothing ever queries a single
-- stop event -- the analysis queries are answered from the aggregate tables below, and
-- this table exists for replay and forensics, where the unit is always a whole trip. As
-- arrays it is 625,000 rows a quarter and about a tenth of the disk.
--
-- Partitioned by day so retention is a metadata operation. Dropping a partition is
-- instant; deleting eight million rows is an afternoon of vacuum.

CREATE TABLE IF NOT EXISTS trip_observation (
  service_date date     NOT NULL,
  agency       text     NOT NULL,
  trip_id      text     NOT NULL,
  route_id     text     NOT NULL,
  direction_id smallint NOT NULL DEFAULT 0,
  pattern_id   text     NOT NULL DEFAULT '',
  block_id     text     NOT NULL DEFAULT '',
  vehicle_id   text     NOT NULL DEFAULT '',

  -- Parallel arrays, one entry per observed stop, in sequence order.
  seqs         integer[] NOT NULL,
  stop_ids     text[]    NOT NULL,
  sched_dep    integer[] NOT NULL,  -- epoch seconds
  act_dep      integer[] NOT NULL,
  act_arr      integer[] NOT NULL,  -- 0 where the tier could not see an arrival
  dev_dep      integer[] NOT NULL,
  delta        integer[] NOT NULL,  -- NULL-equivalent sentinel where there was no prior stop
  tiers        smallint[] NOT NULL,
  held         boolean[]  NOT NULL,

  -- What the agency predicted, as an error in seconds, one slot per horizon bucket.
  -- Flattened row-major: stop index * horizons + horizon index. Absent slots are the
  -- sentinel, which is not the same as an error of zero and must never be read as one.
  pred_err     integer[] NOT NULL DEFAULT '{}',

  -- A network-wide event. The rows are kept -- they are the incident dataset -- and
  -- excluded from training, because one bridge closure otherwise argues about every
  -- Transbay segment for three weeks.
  anomalous    boolean   NOT NULL DEFAULT false,
  written_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (service_date, trip_id)
) PARTITION BY RANGE (service_date);

CREATE TABLE IF NOT EXISTS trip_observation_default
  PARTITION OF trip_observation DEFAULT;
