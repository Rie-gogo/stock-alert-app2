CREATE TABLE `paper_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`symbolName` varchar(50) NOT NULL,
	`side` enum('long','short') NOT NULL,
	`entryPrice` decimal(12,2) NOT NULL,
	`quantity` int NOT NULL,
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`exitPrice` decimal(12,2),
	`pnl` bigint,
	`note` text,
	`entryAt` timestamp NOT NULL DEFAULT (now()),
	`exitAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paper_trades_id` PRIMARY KEY(`id`)
);
