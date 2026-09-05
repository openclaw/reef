ALTER TABLE friendships
  ADD COLUMN a_inbound_allowed INTEGER NOT NULL DEFAULT 1 CHECK (a_inbound_allowed IN (0, 1));

ALTER TABLE friendships
  ADD COLUMN b_inbound_allowed INTEGER NOT NULL DEFAULT 1 CHECK (b_inbound_allowed IN (0, 1));
