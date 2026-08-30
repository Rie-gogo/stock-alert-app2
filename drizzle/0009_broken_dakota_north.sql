CREATE TABLE `rt_sumco_breakdown_short_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`sumco_breakdown_short_event_type` enum('engine_rejected') NOT NULL,
	`sumco_breakdown_short_event_side` enum('short') NOT NULL,
	`detail` text,
	`reference_price` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_sumco_breakdown_short_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_sumco_breakdown_short_event_identity` UNIQUE(`trade_date`,`symbol`,`candle_time`,`sumco_breakdown_short_event_type`,`sumco_breakdown_short_event_side`)
);
