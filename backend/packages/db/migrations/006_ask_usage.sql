-- "Ask DEODScan AI": a daily usage counter, so the assistant can never spend more than the owner allows (ASK_DAILY_LIMIT questions per UTC day).
-- Only counters are stored: questions and answers are NOT saved. Nothing in this migration touches existing tables.
CREATE TABLE ask_usage (
  day            date PRIMARY KEY,
  requests       int    NOT NULL DEFAULT 0,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  unverified     int    NOT NULL DEFAULT 0,   -- answers withheld because a figure could not be matched to the data
  failed         int    NOT NULL DEFAULT 0    -- requests that ended in an error (bad key, quota, timeout, ...)
);
