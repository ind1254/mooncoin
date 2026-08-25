-- New shadow-bot configs follow the concentrated live-v2 signal threshold.
-- Existing configs remain untouched because their threshold may be an
-- intentional user choice, including while the bot is disabled.

alter table paper_bot_configs
  alter column min_quality_score set default 90;
