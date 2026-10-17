-- Issue #1155 item 1: measure the pre-header wait — how long env.AI.run blocks
-- before any Response could exist (nothing can be written in that window, so no
-- ping fires there). time_to_headers = ms from request start to
-- runModelPoolOverflow resolving, lead rows only (NULL elsewhere).
ALTER TABLE junior_usage_log ADD COLUMN time_to_headers INTEGER;