-- Seek and page through a channel's top-level timeline in message ID order.
CREATE INDEX idx_messages_channel_timeline ON messages(channel_id, id)
  WHERE thread_id IS NULL;
