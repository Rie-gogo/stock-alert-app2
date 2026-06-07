CREATE TABLE `kabu_plan_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`planType` enum('normal','professional','premium') NOT NULL DEFAULT 'professional',
	`planExpiresAt` varchar(10) NOT NULL,
	`reminderSent` boolean NOT NULL DEFAULT false,
	`reminderSentAt` timestamp,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `kabu_plan_settings_id` PRIMARY KEY(`id`)
);
