import type { TimeClock } from "./time-clock";

export interface Env {
  DB: D1Database;
  TIME_CLOCK: DurableObjectNamespace<TimeClock>;
  ASSETS: Fetcher;
  LOGOS: R2Bucket;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /**
   * Client ID (`<id>.access`) of the Access service token used by desktop
   * clients such as the Omarchy bar widget. That token may read status and
   * totals and start or stop sessions; every other service token remains
   * limited to the live event stream. Set as a Worker secret.
   */
  BAR_SERVICE_TOKEN?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export type AppEnv = { Bindings: Env };
