-- Cleanup can advance runtime_call_stopped after a Tool finish commits. Keep
-- the original finish input separately so a lost receipt can be confirmed
-- without reverting that later evidence or accepting a changed request.
-- Historical rows intentionally remain NULL: their original input is unknown.
ALTER TABLE tool_attempts
    ADD COLUMN finish_runtime_call_stopped boolean;
