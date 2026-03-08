/**
 * Worker pool for parallel benchmark execution.
 * Uses child_process.fork() with tsx for TypeScript worker support.
 */
import { fork } from "node:child_process";
import { cpus } from "node:os";
import { join } from "node:path";
import type { AnalysisResult } from "../src/types.js";

const WORKER_PATH = join(import.meta.dirname, "worker.ts");
const DEFAULT_CONCURRENCY = Math.min(cpus().length - 1, 6);

interface PoolTask {
  spec: string;
  typesVersion?: string;
  domain?: string;
}

interface PoolResult {
  spec: string;
  result: AnalysisResult | null;
  error: string | null;
  durationMs: number;
}

export interface PoolOptions {
  concurrency?: number;
  onProgress?: (completed: number, total: number, spec: string) => void;
}

/**
 * Run scoring tasks in parallel using a process pool.
 * Returns results in the same order as the input tasks.
 */
export async function runPool(
  tasks: PoolTask[],
  options?: PoolOptions,
): Promise<PoolResult[]> {
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const results: PoolResult[] = new Array(tasks.length);
  let nextIdx = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    const workers: ReturnType<typeof fork>[] = [];
    let activeCount = 0;
    let finished = false;

    function scheduleNext(worker: ReturnType<typeof fork>) {
      if (nextIdx >= tasks.length) {
        worker.kill();
        activeCount--;
        if (activeCount === 0 && !finished) {
          finished = true;
          resolve(results);
        }
        return;
      }

      const idx = nextIdx++;
      const task = tasks[idx]!;
      const start = performance.now();

      worker.removeAllListeners("message");
      worker.on("message", (msg: any) => {
        if (msg.ready) {
          // Worker ready — send task
          worker.send(task);
          return;
        }

        // Result received
        const durationMs = Math.round(performance.now() - start);
        results[idx] = {
          durationMs,
          error: msg.error,
          result: msg.result,
          spec: task.spec,
        };
        completed++;
        options?.onProgress?.(completed, tasks.length, task.spec);

        // Schedule next task for this worker
        scheduleNext(worker);
      });

      // If worker is already listening, send task directly
      worker.send(task);
    }

    function spawnWorker() {
      const worker = fork(WORKER_PATH, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      worker.on("error", (err) => {
        if (!finished) {
          finished = true;
          // Kill all workers on error
          for (const w of workers) {
            try {
              w.kill();
            } catch {
              // Ignore
            }
          }
          reject(err);
        }
      });

      worker.on("exit", (code) => {
        if (code !== 0 && code !== null && !finished) {
          activeCount--;
          if (activeCount === 0) {
            finished = true;
            resolve(results);
          }
        }
      });

      workers.push(worker);
      activeCount++;

      // Wait for ready signal, then schedule first task
      worker.on("message", function onReady(msg: any) {
        if (msg.ready) {
          worker.removeListener("message", onReady);
          scheduleNext(worker);
        }
      });
    }

    // Spawn workers up to concurrency limit
    const workerCount = Math.min(concurrency, tasks.length);
    for (let i = 0; i < workerCount; i++) {
      spawnWorker();
    }

    // Handle empty task list
    if (tasks.length === 0) {
      resolve(results);
    }
  });
}
