ALTER TABLE `companies` DROP COLUMN `pay_period_cadence`;--> statement-breakpoint
ALTER TABLE `companies` DROP COLUMN `pay_period_anchor_date`;--> statement-breakpoint
ALTER TABLE `hour_retrievals` DROP COLUMN `next_period_end`;--> statement-breakpoint
DELETE FROM `sessions` WHERE `ended_at` IS NOT NULL AND `ended_at` - `started_at` < 60000;
