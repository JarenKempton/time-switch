import type { TimeClockEnv } from "../src/time-clock";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends TimeClockEnv {}
}
