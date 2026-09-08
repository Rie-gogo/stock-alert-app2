CREATE TABLE `rt_candidate_virtual_repair_archive` (
		`id` int AUTO_INCREMENT NOT NULL,
		`run_id` varchar(64) NOT NULL,
		`candidate_virtual_repair_archive_entity` enum('candidate','virtual_trade','decision_event','gap') NOT NULL,
	`entity_key` varchar(160) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`payload_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_candidate_virtual_repair_archive_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_candidate_virtual_repair_archive_identity` UNIQUE(`run_id`,`candidate_virtual_repair_archive_entity`,`entity_key`)
);
--> statement-breakpoint
CREATE TABLE `rt_candidate_virtual_repair_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`repair_version` varchar(64) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candidate_virtual_repair_status` enum('draft','replayed','verified','applied','failed') NOT NULL DEFAULT 'draft',
	`input_hash` varchar(64),
	`replay_hash_a` varchar(64),
	`replay_hash_b` varchar(64),
	`candidate_count` int NOT NULL DEFAULT 0,
	`accepted_count` int NOT NULL DEFAULT 0,
	`margin_block_count` int NOT NULL DEFAULT 0,
	`virtual_trade_count` int NOT NULL DEFAULT 0,
	`completed_trade_count` int NOT NULL DEFAULT 0,
	`total_pnl` bigint NOT NULL DEFAULT 0,
	`first_exit_candle_time` varchar(5),
	`detail_json` json NOT NULL,
	`applied_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_candidate_virtual_repair_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_candidate_virtual_repair_run_identity` UNIQUE(`run_id`)
);
--> statement-breakpoint
CREATE TABLE `rt_candidate_virtual_repair_stage` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`candidate_virtual_repair_pass` enum('A','B') NOT NULL,
	`candidate_virtual_repair_entity` enum('candidate','virtual_trade') NOT NULL,
	`entity_key` varchar(160) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`payload_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_candidate_virtual_repair_stage_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_candidate_virtual_repair_stage_identity` UNIQUE(`run_id`,`candidate_virtual_repair_pass`,`candidate_virtual_repair_entity`,`entity_key`)
);
--> statement-breakpoint
ALTER TABLE `rt_signal_candidate_trades` ADD `exit_reason_code` varchar(64);--> statement-breakpoint
ALTER TABLE `rt_signal_candidate_trades` ADD `exit_reason_detail` text;--> statement-breakpoint
UPDATE `rt_signal_candidate_trades`
SET
	`exit_reason_code` = LEFT(SUBSTRING_INDEX(`exit_reason`, ':', 1), 64),
	`exit_reason_detail` = CASE
		WHEN LOCATE(':', `exit_reason`) > 0 THEN SUBSTRING(`exit_reason`, LOCATE(':', `exit_reason`) + 1)
		ELSE NULL
	END
WHERE `exit_reason` IS NOT NULL
	AND `exit_reason_code` IS NULL;
