/**
 * Cron scheduler.
 *
 * Runs scheduled tasks by injecting messages into the agent loop.
 * Uses croner for ESM-native cron scheduling.
 */

import { Cron } from "croner";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";

export interface CronScheduler {
  /** Start all configured cron jobs. */
  start(): void;

  /** Stop all cron jobs. */
  stop(): void;
}

/**
 * Cron message handler function.
 */
type CronMessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Create a cron scheduler based on configuration.
 */
export function createCronScheduler(
  config: Config,
  onMessage: CronMessageHandler,
): CronScheduler {
  const jobs: Cron[] = [];

  return {
    start(): void {
      for (const cronJob of config.cron) {
        try {
          const job = new Cron(
            cronJob.schedule,
            async () => {
              console.log(`Cron job triggered: ${cronJob.schedule}`);

              // Create a synthetic message for the cron job
              const msg: IncomingMessage = {
                channelId: "cron", // Will be resolved based on config
                userId: "cron",
                text: cronJob.message,
                platform: "telegram",
                raw: { type: "cron", schedule: cronJob.schedule },
              };

              await onMessage(msg);
            },
            {
              timezone: "UTC",
            },
          );

          jobs.push(job);
          console.log(`Cron job scheduled: ${cronJob.schedule} -> ${cronJob.message.substring(0, 50)}...`);
        } catch (error) {
          console.error(`Failed to schedule cron job: ${cronJob.schedule}`, error);
        }
      }

      if (jobs.length > 0) {
        console.log(`Cron scheduler started with ${jobs.length} jobs`);
      }
    },

    stop(): void {
      for (const job of jobs) {
        job.stop();
      }
      jobs.length = 0;
      console.log("Cron scheduler stopped");
    },
  };
}
