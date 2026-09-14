CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret` text,
	`setup_token_hash` text,
	`setup_token_expires_at` integer,
	`firmware_version` text,
	`provisioned_at` integer,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_devices_name` ON `devices` (`name`);