CREATE TABLE `rt_softbank_breakout_long_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`softbank_breakout_long_event_type` enum('engine_rejected') NOT NULL,
	`softbank_breakout_long_event_side` enum('long') NOT NULL,
	`detail` text,
	`reference_price` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_softbank_breakout_long_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_softbank_breakout_long_event_identity` UNIQUE(`trade_date`,`symbol`,`candle_time`,`softbank_breakout_long_event_type`,`softbank_breakout_long_event_side`)
);
