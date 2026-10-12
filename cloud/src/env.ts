import type { TimeClock } from "./time-clock";

export interface Env {
  DB: D1Database;
  TIME_CLOCK: DurableObjectNamespace<TimeClock>;
  ASSETS: Fetcher;
  LOGOS: R2Bucket;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export type AppEnv = { Bindings: Env };
