CREATE TABLE `rt_shadow_dispatch_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_event_id` varchar(128) NOT NULL,
	`engine_sequence` int NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`input_json` json NOT NULL,
	`rt_shadow_dispatch_status` enum('pending','processing','processed','error') NOT NULL DEFAULT 'pending',
	`claim_token` varchar(64),
	`lease_until` timestamp,
	`attempt_count` int NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`processed_at` timestamp,
	CONSTRAINT `rt_shadow_dispatch_queue_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_shadow_dispatch_source_identity` UNIQUE(`source_event_id`),
	CONSTRAINT `rt_shadow_dispatch_engine_sequence_identity` UNIQUE(`engine_sequence`)
);
