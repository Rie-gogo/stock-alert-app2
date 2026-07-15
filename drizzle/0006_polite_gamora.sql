CREATE TABLE `rt_3peak_signals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tradeDate` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`direction_3peak` enum('short','long') NOT NULL,
	`signalTime` varchar(5) NOT NULL,
	`entryPrice` decimal(12,2) NOT NULL,
	`exitPrice` decimal(12,2),
	`exitTime` varchar(5),
	`exit_reason_3peak` enum('tp','sl','eod','pending') NOT NULL DEFAULT 'pending',
	`virtualPnl` bigint,
	`shares` int NOT NULL,
	`holdBars` int,
	`consecutiveCount` int NOT NULL,
	`details` text,
	`reportSent` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_3peak_signals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `auto_trade_daily` MODIFY COLUMN `dailyLossLimit` bigint NOT NULL DEFAULT -100000;