-- Messages sent while the agent works wait in the queue. Steer marks one for the running agent to
-- pick up at its next step; the rest run after it, one at a time.
ALTER TABLE instruction_queue ADD COLUMN steer boolean NOT NULL DEFAULT false;
