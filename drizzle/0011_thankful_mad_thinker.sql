CREATE TABLE `rt_kioxia_short_guard_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`kioxia_short_guard_type` enum('reversal_short_bpr','safe_cb_volume') NOT NULL,
	`kioxia_short_guard_side` enum('short') NOT NULL,
	`observed_value` decimal(12,6) NOT NULL,
	`threshold_value` decimal(12,6) NOT NULL,
	`average_volume` decimal(16,4),
	`zero_volume_bars` int NOT NULL DEFAULT 0,
	`detail` text,
	`reference_price` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_kioxia_short_guard_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_kioxia_short_guard_event_identity` UNIQUE(`trade_date`,`symbol`,`candle_time`,`kioxia_short_guard_type`)
);
