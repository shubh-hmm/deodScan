-- Backfill progress is tracked separately from the incremental checkpoint so that a resume only
-- continues the same backfill (same requested start), never jumps over an unsynced gap.
ALTER TABLE dune_sync_state
  ADD COLUMN backfill_from   timestamptz,
  ADD COLUMN backfill_cursor timestamptz;
