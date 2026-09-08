CREATE TABLE `rt_eod_execution_controls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`execution_kind` varchar(64) NOT NULL,
	`rt_eod_execution_status` enum('pending','processing','complete','failed') NOT NULL DEFAULT 'pending',
	`lease_owner` varchar(128),
	`lease_expires_at` timestamp,
	`attempt_count` int NOT NULL DEFAULT 0,
	`last_error` text,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_eod_execution_controls_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_eod_execution_identity` UNIQUE(`trade_date`,`execution_kind`)
);
--> statement-breakpoint
CREATE TABLE `rt_report_delivery_controls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`report_kind` varchar(64) NOT NULL,
	`rt_report_delivery_status` enum('pending','sending','sent','failed') NOT NULL DEFAULT 'pending',
	`lease_owner` varchar(128),
	`lease_expires_at` timestamp,
	`attempt_count` int NOT NULL DEFAULT 0,
	`last_error` text,
	`payload_hash` varchar(64),
	`sent_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_report_delivery_controls_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_report_delivery_identity` UNIQUE(`trade_date`,`report_kind`)
);
--> statement-breakpoint
INSERT INTO `rt_report_delivery_controls` (
	`trade_date`,
	`report_kind`,
	`rt_report_delivery_status`,
	`attempt_count`,
	`sent_at`
)
SELECT
	`tradeDate`,
	'rt-daily-report',
	'sent',
	1,
	`reportSentAt`
FROM `rt_daily_summaries`
WHERE `reportSent` = true
ON DUPLICATE KEY UPDATE
	`rt_report_delivery_status` = 'sent',
	`lease_owner` = NULL,
	`lease_expires_at` = NULL,
	`sent_at` = COALESCE(`sent_at`, VALUES(`sent_at`));
--> statement-breakpoint
INSERT INTO `rt_eod_execution_controls` (
	`trade_date`,
	`execution_kind`,
	`rt_eod_execution_status`,
	`attempt_count`,
	`completed_at`
)
SELECT
	`tradeDate`,
	'rt-daily-force-close',
	'complete',
	1,
	COALESCE(`reportSentAt`, `updatedAt`)
FROM `rt_daily_summaries`
WHERE `reportSent` = true
ON DUPLICATE KEY UPDATE
	`rt_eod_execution_status` = 'complete',
	`lease_owner` = NULL,
	`lease_expires_at` = NULL,
	`completed_at` = COALESCE(`completed_at`, VALUES(`completed_at`));
