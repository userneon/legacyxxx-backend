-- Chat rooms (owner request 2026-11-01): the community chat stays the room "global"; a clan gets a private room "clan:<clan id>" that only its members
-- read and write (the API checks the membership; the table is still only reachable through the Root API). Safe to re-run.
ALTER TABLE legacy_x.chat_messages ADD COLUMN IF NOT EXISTS room text NOT NULL DEFAULT 'global';
ALTER TABLE legacy_x.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_room_check;
ALTER TABLE legacy_x.chat_messages ADD CONSTRAINT chat_messages_room_check CHECK (room ~ '^(global|clan:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
CREATE INDEX IF NOT EXISTS chat_messages_room_idx ON legacy_x.chat_messages (room, created_at DESC) WHERE deleted_at IS NULL;
NOTIFY pgrst, 'reload schema';
