CREATE TABLE `rt_market_context_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_event_id` varchar(128) NOT NULL,
	`relay_session_id` varchar(96) NOT NULL,
	`event_seq` int NOT NULL,
	`instrument_key` varchar(32) NOT NULL,
	`provider_symbol` varchar(32) NOT NULL,
	`market_context_product_type` enum('index','future') NOT NULL,
	`contract_month` varchar(7),
	`market_context_session` enum('cash','day','night','day_night') NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`open` decimal(16,6) NOT NULL,
	`high` decimal(16,6) NOT NULL,
	`low` decimal(16,6) NOT NULL,
	`close` decimal(16,6) NOT NULL,
	`volume` bigint,
	`previous_close` decimal(16,6),
	`payload_hash` varchar(64) NOT NULL,
	`relay_payload_hash` varchar(64),
	`payload_json` json NOT NULL,
	`observed_at_ms` bigint,
	`relay_sent_at_ms` bigint,
	`cloud_received_at_ms` bigint NOT NULL,
	`corrected_event_id` varchar(128),
	`market_context_quality_status` enum('verified','degraded','invalid') NOT NULL,
	`result_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_market_context_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_market_context_source_identity` UNIQUE(`source_event_id`)
);
--> statement-breakpoint
CREATE INDEX `rt_market_context_instrument_date_time` ON `rt_market_context_events` (`instrument_key`,`trade_date`,`candle_time`,`id`);--> statement-breakpoint
CREATE INDEX `rt_market_context_trade_date_quality` ON `rt_market_context_events` (`trade_date`,`market_context_quality_status`,`id`);