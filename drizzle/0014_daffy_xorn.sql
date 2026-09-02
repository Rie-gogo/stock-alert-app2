CREATE TABLE `rt_forward_shadow_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategy_version` varchar(64) NOT NULL,
	`source_event_id` varchar(128) NOT NULL,
	`rt_forward_evaluation_mode` enum('signal_quality','capital_constrained') NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`rt_forward_result_type` enum('no_signal','pending','entry','hold','exit','rejected','error') NOT NULL,
	`decision_json` json NOT NULL,
	`state_hash_before` varchar(64) NOT NULL,
	`state_hash_after` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_forward_shadow_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_forward_shadow_event_identity` UNIQUE(`strategy_version`,`source_event_id`,`rt_forward_evaluation_mode`)
);
--> statement-breakpoint
CREATE TABLE `rt_forward_shadow_states` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategy_version` varchar(64) NOT NULL,
	`rt_forward_state_mode` enum('signal_quality','capital_constrained') NOT NULL,
	`state_json` json NOT NULL,
	`state_hash` varchar(64) NOT NULL,
	`last_source_event_id` varchar(128),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_forward_shadow_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_forward_shadow_state_identity` UNIQUE(`strategy_version`,`rt_forward_state_mode`)
);
--> statement-breakpoint
CREATE TABLE `rt_forward_shadow_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategy_version` varchar(64) NOT NULL,
	`rt_forward_trade_mode` enum('signal_quality','capital_constrained') NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`rt_forward_trade_side` enum('long','short') NOT NULL,
	`entry_source_event_id` varchar(128) NOT NULL,
	`entry_trade_date` varchar(10) NOT NULL,
	`signal_candle_time` varchar(5) NOT NULL,
	`entry_candle_time` varchar(5) NOT NULL,
	`theoretical_signal_price` decimal(12,4) NOT NULL,
	`entry_price` decimal(12,4) NOT NULL,
	`shares` int NOT NULL,
	`sl_pct` decimal(8,4) NOT NULL,
	`tp_pct` decimal(8,4) NOT NULL,
	`exit_source_event_id` varchar(128),
	`exit_trade_date` varchar(10),
	`exit_candle_time` varchar(5),
	`exit_price` decimal(12,4),
	`exit_reason` varchar(64),
	`pnl` int,
	`pnl_after_adverse_exit` int,
	`realized_r` decimal(12,6),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`closed_at` timestamp,
	CONSTRAINT `rt_forward_shadow_trades_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_forward_shadow_trade_identity` UNIQUE(`strategy_version`,`rt_forward_trade_mode`,`entry_source_event_id`)
);
--> statement-breakpoint
CREATE TABLE `rt_source_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_event_id` varchar(128) NOT NULL,
	`relay_session_id` varchar(96) NOT NULL,
	`event_seq` int NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`trade_date` varchar(10) NOT NULL,
	`candle_time` varchar(5) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`relay_received_at_ms` bigint,
	`relay_sent_at_ms` bigint,
	`corrected_event_id` varchar(128),
	`rt_source_event_status` enum('processing','processed','failed','payload_mismatch') NOT NULL DEFAULT 'processing',
	`result_action` varchar(32),
	`result_json` json,
	`error_detail` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`processed_at` timestamp,
	CONSTRAINT `rt_source_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_source_events_source_identity` UNIQUE(`source_event_id`)
);
--> statement-breakpoint
CREATE TABLE `rt_strategy_versions` (
	`version_id` varchar(64) NOT NULL,
	`strategy_id` varchar(64) NOT NULL,
	`baseline_git_sha` varchar(64) NOT NULL,
	`build_git_sha` varchar(64) NOT NULL,
	`source_tree_hash` varchar(64) NOT NULL,
	`config_hash` varchar(64) NOT NULL,
	`config_json` json NOT NULL,
	`learning_cutoff_date` varchar(10) NOT NULL,
	`evaluation_start_date` varchar(10) NOT NULL,
	`rt_strategy_version_status` enum('monitoring','interim_continue','eligible','stopped','insufficient') NOT NULL DEFAULT 'monitoring',
	`status_reason` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_strategy_versions_version_id` PRIMARY KEY(`version_id`)
);
