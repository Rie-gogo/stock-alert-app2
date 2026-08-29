CREATE TABLE IF NOT EXISTS `rt_taiyo_candidate_b_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`taiyo_candidate_b_event_type` enum('confirmation_rejected','engine_rejected') NOT NULL,
	`taiyo_candidate_b_event_side` enum('long','short') NOT NULL,
	`trigger_time` varchar(5) NOT NULL,
	`rejection_codes` json,
	`detail` text,
	`reference_price` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_taiyo_candidate_b_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_taiyo_candidate_b_event_identity` UNIQUE(`trade_date`,`symbol`,`candle_time`,`taiyo_candidate_b_event_type`,`taiyo_candidate_b_event_side`,`trigger_time`)
);
