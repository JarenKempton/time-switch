ALTER TABLE `companies` ADD `pay_period_cadence` text DEFAULT 'biweekly' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `pay_period_anchor_date` text;