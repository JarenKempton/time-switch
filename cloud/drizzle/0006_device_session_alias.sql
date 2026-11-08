ALTER TABLE `sessions` ADD `device_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_device_session_id` ON `sessions` (`device_session_id`);