CREATE TABLE `rt_forward_shadow_locks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategy_version` varchar(64) NOT NULL,
	`rt_forward_lock_mode` enum('signal_quality','capital_constrained') NOT NULL,
	`owner_token` varchar(64),
	`lease_until` timestamp,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_forward_shadow_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_forward_shadow_lock_identity` UNIQUE(`strategy_version`,`rt_forward_lock_mode`)
);
--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_events` ADD `claim_token` varchar(64);--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_events` ADD `claim_until` timestamp;--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_events` ADD `attempt_count` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_forward_shadow_events` ADD `last_error` text;