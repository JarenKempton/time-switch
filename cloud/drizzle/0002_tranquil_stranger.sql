CREATE TABLE `hour_retrievals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`next_period_end` integer NOT NULL,
	`total_seconds` integer NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_hour_retrievals_company_period_end` ON `hour_retrievals` (`company_id`,`period_end`);