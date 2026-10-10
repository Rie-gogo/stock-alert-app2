CREATE TABLE `rt_ai_forecast_learning_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_snapshot_id` varchar(180) NOT NULL,
	`as_of_date` varchar(10) NOT NULL,
	`model_version` varchar(96) NOT NULL,
	`generated_at_ms` bigint NOT NULL,
	`input_hash` varchar(64) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`ai_forecast_learning_quality` enum('verified','degraded','invalid') NOT NULL,
	`quality_reason_codes_json` json NOT NULL,
	`learning_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_ai_forecast_learning_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_ai_forecast_learning_source_identity` UNIQUE(`source_snapshot_id`),
	CONSTRAINT `rt_ai_forecast_learning_asof_model_identity` UNIQUE(`as_of_date`,`model_version`)
);
--> statement-breakpoint
CREATE INDEX `rt_ai_forecast_learning_usable_before_trade_date` ON `rt_ai_forecast_learning_snapshots` (`model_version`,`ai_forecast_learning_quality`,`as_of_date`,`id`);