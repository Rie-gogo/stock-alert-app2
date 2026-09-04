ALTER TABLE `rt_forward_shadow_events` MODIFY COLUMN `strategy_version` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_locks` MODIFY COLUMN `strategy_version` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_states` MODIFY COLUMN `strategy_version` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_trades` MODIFY COLUMN `strategy_version` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_strategy_versions` MODIFY COLUMN `version_id` varchar(128) NOT NULL;