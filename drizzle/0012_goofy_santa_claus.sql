CREATE TABLE `rt_kioxia_confirmed_morning_long_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`kioxia_confirmed_morning_long_event_type` enum('engine_rejected') NOT NULL,
	`kioxia_confirmed_morning_long_event_side` enum('long') NOT NULL,
	`detail` text,
	`reference_price` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_kioxia_confirmed_morning_long_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_kioxia_confirmed_morning_long_event_identity` UNIQUE(`trade_date`,`symbol`,`candle_time`,`kioxia_confirmed_morning_long_event_type`,`kioxia_confirmed_morning_long_event_side`)
);
