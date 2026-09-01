CREATE TABLE `rt_tel_open_direction_breakout_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`tel_open_direction_breakout_event_type` enum('engine_rejected') NOT NULL,
	`tel_open_direction_breakout_event_side` enum('long','short') NOT NULL,
	`detail` text,
	`reference_price` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_tel_open_direction_breakout_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_tel_open_direction_breakout_event_identity` UNIQUE(`trade_date`,`symbol`,`candle_time`,`tel_open_direction_breakout_event_type`,`tel_open_direction_breakout_event_side`)
);
