CREATE TABLE `rt_candidate_virtual_gaps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`decision_event_id` int NOT NULL,
	`source_event_id` varchar(128) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`candidate_virtual_gap_phase` enum('candidate','virtual') NOT NULL,
	`reason_code` varchar(96) NOT NULL,
	`detail_json` json NOT NULL,
	`resolved` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_candidate_virtual_gaps_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_candidate_virtual_gap_identity` UNIQUE(`decision_event_id`,`candidate_virtual_gap_phase`)
);
--> statement-breakpoint
CREATE TABLE `rt_candidate_virtual_worker_locks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`lock_name` varchar(64) NOT NULL,
	`owner_token` varchar(64),
	`lease_until` timestamp,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_candidate_virtual_worker_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_candidate_virtual_worker_lock_identity` UNIQUE(`lock_name`)
);
--> statement-breakpoint
CREATE TABLE `rt_daily_audit_materializations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`component` varchar(64) NOT NULL,
	`version` varchar(64) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`daily_audit_materialization_status` enum('pending','processing','complete','error','incomplete_source') NOT NULL DEFAULT 'pending',
	`processed_through_engine_sequence` int NOT NULL DEFAULT 0,
	`source_decision_count` int NOT NULL DEFAULT 0,
	`result_json` json NOT NULL,
	`last_error` text,
	`generated_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_daily_audit_materializations_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_daily_audit_materialization_identity` UNIQUE(`component`,`version`,`trade_date`)
);
--> statement-breakpoint
CREATE TABLE `rt_forward_evaluation_controls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`control_name` varchar(64) NOT NULL,
	`activated` boolean NOT NULL DEFAULT false,
	`activation_checkpoint_id` varchar(64),
	`activated_at_utc` timestamp,
	`formal_start_trade_date` varchar(10),
	`excluded_trade_dates_json` json NOT NULL,
	`reason` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_forward_evaluation_controls_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_forward_evaluation_control_identity` UNIQUE(`control_name`)
);
--> statement-breakpoint
CREATE TABLE `rt_portfolio_materialization_progress` (
	`id` int AUTO_INCREMENT NOT NULL,
	`portfolio_version` varchar(64) NOT NULL,
	`portfolio_materialization_mode` enum('actual_receipt','minute_normalized') NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`portfolio_materialization_status` enum('pending','processing','complete','error','incomplete_source') NOT NULL DEFAULT 'pending',
	`processed_through_engine_sequence` int NOT NULL DEFAULT 0,
	`source_decision_count` int NOT NULL DEFAULT 0,
	`open_allocations_json` json NOT NULL,
	`margin_used` bigint NOT NULL DEFAULT 0,
	`dirty_from_engine_sequence` int,
	`result_json` json NOT NULL,
	`last_error` text,
	`generated_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_portfolio_materialization_progress_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_portfolio_materialization_progress_identity` UNIQUE(`portfolio_version`,`portfolio_materialization_mode`,`trade_date`)
);
--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` MODIFY COLUMN `rt_candidate_virtual_status` enum('pending','processing','processed','error','terminal') NOT NULL DEFAULT 'processed';--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_descriptor_json` json;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_phase_status` enum('pending','processing','complete','retryable_error','terminal_error','not_applicable') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_phase_attempt_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_phase_last_error` text;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_phase_processed_at` timestamp;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `virtual_phase_status` enum('pending','processing','complete','retryable_error','terminal_error','not_applicable') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `virtual_phase_attempt_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `virtual_phase_last_error` text;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `virtual_phase_processed_at` timestamp;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_terminal_at` timestamp;--> statement-breakpoint
UPDATE `rt_realtime_decision_events` d
LEFT JOIN `rt_signal_candidates` c
  ON c.`candidate_version` = 'current-10-symbol-candidates-v1'
 AND c.`source_event_id` = d.`source_event_id`
SET
  d.`candidate_phase_status` = CASE
    WHEN d.`rt_candidate_virtual_status` = 'processed' AND c.`id` IS NOT NULL THEN 'complete'
    WHEN d.`rt_candidate_virtual_status` = 'processed' THEN 'not_applicable'
    WHEN c.`id` IS NOT NULL THEN 'complete'
    ELSE 'pending'
  END,
  d.`candidate_phase_processed_at` = CASE
    WHEN d.`rt_candidate_virtual_status` = 'processed' OR c.`id` IS NOT NULL
      THEN COALESCE(d.`candidate_virtual_processed_at`, d.`created_at`)
    ELSE NULL
  END,
  d.`virtual_phase_status` = CASE
    WHEN d.`rt_candidate_virtual_status` = 'processed' THEN 'complete'
    ELSE 'pending'
  END,
  d.`virtual_phase_processed_at` = CASE
    WHEN d.`rt_candidate_virtual_status` = 'processed'
      THEN COALESCE(d.`candidate_virtual_processed_at`, d.`created_at`)
    ELSE NULL
  END;--> statement-breakpoint
INSERT INTO `rt_forward_evaluation_controls` (
  `control_name`,
  `activated`,
  `activation_checkpoint_id`,
  `activated_at_utc`,
  `formal_start_trade_date`,
  `excluded_trade_dates_json`,
  `reason`
) VALUES (
  'forward-shadow-formal-v1',
  false,
  NULL,
  NULL,
  NULL,
  JSON_ARRAY('2026-09-07'),
  'P0 audit remediation pending; manual activation required after one complete validation day'
) ON DUPLICATE KEY UPDATE `control_name` = VALUES(`control_name`);
