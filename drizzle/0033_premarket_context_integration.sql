CREATE TABLE `rt_premarket_context_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_snapshot_id` varchar(128) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`captured_at_ms` bigint NOT NULL,
	`collector_version` varchar(96) NOT NULL,
	`premarket_source_mode` enum('scheduled_research','provider_api','manual_review') NOT NULL,
	`dow_session_date` varchar(10),
	`dow_close` decimal(16,6),
	`dow_change_pct` decimal(10,6),
	`cme_provider_symbol` varchar(32),
	`cme_contract_month` varchar(7),
	`cme_currency` enum('JPY','USD'),
	`cme_quote` decimal(16,6),
	`ose_day_close` decimal(16,6),
	`cme_basis_pct` decimal(10,6),
	`usd_jpy_previous` decimal(16,6),
	`usd_jpy_current` decimal(16,6),
	`usd_jpy_change_pct` decimal(10,6),
	`input_hash` varchar(64) NOT NULL,
	`rule_version` varchar(96) NOT NULL,
	`premarket_quality_status` enum('verified','degraded','invalid') NOT NULL,
	`premarket_regime_state` enum('strong_up','up','mixed','down','strong_down','unavailable') NOT NULL,
	`premarket_confidence` enum('high','medium','low','unavailable') NOT NULL,
	`input_json` json NOT NULL,
	`result_json` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_premarket_context_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_premarket_context_source_identity` UNIQUE(`source_snapshot_id`)
);
--> statement-breakpoint
CREATE INDEX `rt_premarket_context_trade_date_capture` ON `rt_premarket_context_snapshots` (`trade_date`,`captured_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `rt_premarket_context_trade_date_quality` ON `rt_premarket_context_snapshots` (`trade_date`,`premarket_quality_status`,`id`);