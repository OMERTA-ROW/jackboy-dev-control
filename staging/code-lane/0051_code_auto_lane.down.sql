-- Rollback for the staged automatic-lane switch. Without the table, every CODE request stays in the reviewed lane.
DROP FUNCTION IF EXISTS public.set_code_auto_lane(uuid, text, boolean);
DROP TABLE IF EXISTS public.code_auto_lane;
