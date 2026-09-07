CREATE TABLE `rt_audit_trade_date_finality` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`audit_trade_date_finality_status` enum('open','closed','reopened') NOT NULL DEFAULT 'open',
	`watermark_hash` varchar(64),
	`watermark_json` json NOT NULL,
	`latest_upstream_created_at` timestamp,
	`closed_at` timestamp,
	`reason` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_audit_trade_date_finality_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_audit_trade_date_finality_identity` UNIQUE(`trade_date`)
);
--> statement-breakpoint
ALTER TABLE `rt_portfolio_audit_events` ADD `generation` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_portfolio_materialization_progress` ADD `active_generation` int;--> statement-breakpoint
ALTER TABLE `rt_portfolio_materialization_progress` ADD `building_generation` int;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_descriptor_status` enum('not_candidate','complete','error') DEFAULT 'not_candidate' NOT NULL;--> statement-breakpoint
UPDATE `rt_realtime_decision_events`
SET `candidate_descriptor_status` = CASE
  WHEN `candidate_descriptor_json` IS NOT NULL THEN 'complete'
  WHEN JSON_EXTRACT(`candidate_virtual_input_json`, '$.candidateDescriptorError') IS NOT NULL
    AND JSON_TYPE(JSON_EXTRACT(`candidate_virtual_input_json`, '$.candidateDescriptorError')) <> 'NULL'
    THEN 'error'
  ELSE 'not_candidate'
END;--> statement-breakpoint
UPDATE `rt_portfolio_materialization_progress`
SET `active_generation` = CASE WHEN `portfolio_materialization_status` = 'complete' THEN 1 ELSE NULL END,
    `building_generation` = CASE WHEN `portfolio_materialization_status` = 'complete' THEN NULL ELSE 1 END;--> statement-breakpoint
ALTER TABLE `rt_portfolio_audit_events` DROP INDEX `rt_portfolio_audit_identity`;--> statement-breakpoint
ALTER TABLE `rt_portfolio_audit_events` ADD CONSTRAINT `rt_portfolio_audit_identity` UNIQUE(`portfolio_version`,`rt_portfolio_audit_mode`,`generation`,`source_event_id`);
