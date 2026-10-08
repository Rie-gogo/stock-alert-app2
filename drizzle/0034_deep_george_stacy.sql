CREATE TABLE `rt_ai_daily_forecast_revisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_snapshot_id` varchar(160) NOT NULL,
	`revision_source_event_id` varchar(128) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`checkpoint` varchar(5) NOT NULL,
	`ai_daily_forecast_revision_status` enum('no_change','market_context_invalidated','invalid') NOT NULL,
	`result_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_ai_daily_forecast_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_ai_daily_forecast_revision_identity` UNIQUE(`source_snapshot_id`,`revision_source_event_id`)
);
--> statement-breakpoint
CREATE TABLE `rt_ai_daily_forecast_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_snapshot_id` varchar(160) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`captured_at_ms` bigint NOT NULL,
	`data_cutoff_date` varchar(10) NOT NULL,
	`model_version` varchar(96) NOT NULL,
	`ai_daily_forecast_source_mode` enum('scheduled_ai_forecast','manual_dry_run') NOT NULL,
	`macro_snapshot_id` varchar(128),
	`input_hash` varchar(64) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`ai_daily_forecast_quality` enum('verified','degraded','invalid') NOT NULL,
	`ai_model_id` varchar(96),
	`prompt_version` varchar(96) NOT NULL,
	`inference_at_ms` bigint,
	`input_json` json NOT NULL,
	`forecast_json` json NOT NULL,
	`validation_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_ai_daily_forecast_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_ai_daily_forecast_source_identity` UNIQUE(`source_snapshot_id`)
);
--> statement-breakpoint
CREATE INDEX `rt_ai_daily_forecast_revision_trade_date_checkpoint` ON `rt_ai_daily_forecast_revisions` (`trade_date`,`checkpoint`,`id`);--> statement-breakpoint
CREATE INDEX `rt_ai_daily_forecast_trade_date_capture` ON `rt_ai_daily_forecast_snapshots` (`trade_date`,`captured_at_ms`,`id`);