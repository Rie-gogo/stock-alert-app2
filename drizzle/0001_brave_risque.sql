ALTER TABLE `stock_reports` ADD `signals` json;--> statement-breakpoint
ALTER TABLE `stock_reports` ADD `isRealData` boolean DEFAULT false NOT NULL;