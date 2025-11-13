-- Add support for 'skipped_old' status
-- This status is used to mark notifications that are older than 30 minutes
-- when the database is empty on first pull. These mentions are stored but not processed.

-- Add comment to document the status field values
COMMENT ON COLUMN mentions.status IS 'Status of mention processing: received|processing|completed|failed|skipped_old';

-- Create index for skipped_old status to optimize queries
-- (status index already exists, but this documents the usage)
