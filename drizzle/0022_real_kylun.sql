ALTER TABLE `rt_realtime_decision_events` ADD `rt_candidate_virtual_status` enum('pending','processing','processed','error') DEFAULT 'processed' NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_input_json` json;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_claim_token` varchar(64);--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_lease_until` timestamp;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_attempt_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_last_error` text;--> statement-breakpoint
ALTER TABLE `rt_realtime_decision_events` ADD `candidate_virtual_processed_at` timestamp;--> statement-breakpoint
ALTER TABLE `rt_source_events` ADD `rt_source_processing_stage` enum('claimed','engine_started','engine_completed') DEFAULT 'claimed' NOT NULL;--> statement-breakpoint
ALTER TABLE `rt_source_events` ADD `claim_token` varchar(64);--> statement-breakpoint
ALTER TABLE `rt_source_events` ADD `lease_until` timestamp;--> statement-breakpoint
ALTER TABLE `rt_source_events` ADD `attempt_count` int DEFAULT 0 NOT NULL;