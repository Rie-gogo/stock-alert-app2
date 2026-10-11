CREATE TABLE `rt_ai_postmarket_learning_reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`review_id` varchar(180) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`input_hash` varchar(64) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`generated_at_ms` bigint NOT NULL,
	`generator_id` varchar(96) NOT NULL,
	`prompt_version` varchar(128) NOT NULL,
	`model_id` varchar(128) NOT NULL,
	`ai_postmarket_learning_review_status` enum('observation_only','candidate','validated','rejected') NOT NULL,
	`review_json` json NOT NULL,
	`validation_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_ai_postmarket_learning_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_ai_postmarket_learning_review_identity` UNIQUE(`review_id`)
);
--> statement-breakpoint
CREATE INDEX `rt_ai_postmarket_learning_trade_date_status` ON `rt_ai_postmarket_learning_reviews` (`trade_date`,`ai_postmarket_learning_review_status`,`id`);--> statement-breakpoint
CREATE INDEX `rt_ai_postmarket_learning_input_hash` ON `rt_ai_postmarket_learning_reviews` (`input_hash`,`id`);