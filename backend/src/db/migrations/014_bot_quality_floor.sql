-- Live-v2 currently reserves 85+ for the automatic smart-watch band. The old
-- 90-point Bot Lab default sat above the live candidate distribution and left
-- a newly enabled bot with an empty pipeline. Move configs still carrying the
-- old default to the same 85-point band, then use it for future configs.

update paper_bot_configs
   set min_quality_score = 85,
       updated_at = now()
 where strategy_version = 'shadow-v1'
   and min_quality_score = 90;

alter table paper_bot_configs
  alter column min_quality_score set default 85;
