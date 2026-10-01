-- Bumped on logout (and any other revocation) so tokens signed with an older
-- version stop working. Existing sessions carry no version and count as 0.
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0;
