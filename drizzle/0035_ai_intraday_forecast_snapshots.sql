CREATE TABLE `rt_ai_intraday_forecast_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_revision_id` varchar(180) NOT NULL,
	`morning_source_snapshot_id` varchar(160) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`checkpoint` varchar(5) NOT NULL,
	`cutoff_candle_time` varchar(5) NOT NULL,
	`captured_at_ms` bigint NOT NULL,
	`model_version` varchar(96) NOT NULL,
	`ai_intraday_forecast_source_mode` enum('scheduled_ai_forecast','manual_dry_run') NOT NULL,
	`input_hash` varchar(64) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`ai_intraday_forecast_quality` enum('verified','degraded','invalid') NOT NULL,
	`ai_model_id` varchar(96),
	`prompt_version` varchar(96) NOT NULL,
	`inference_at_ms` bigint,
	`input_json` json NOT NULL,
	`forecast_json` json NOT NULL,
	`validation_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_ai_intraday_forecast_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_ai_intraday_forecast_source_identity` UNIQUE(`source_revision_id`),
	CONSTRAINT `rt_ai_intraday_forecast_checkpoint_identity` UNIQUE(`morning_source_snapshot_id`,`checkpoint`)
);
--> statement-breakpoint
CREATE INDEX `rt_ai_intraday_forecast_trade_date_checkpoint` ON `rt_ai_intraday_forecast_snapshots` (`trade_date`,`checkpoint`,`id`);