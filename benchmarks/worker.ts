/**
 * Benchmark worker — scores a single package and sends the result back.
 * Designed to be spawned by the parallel runner via child_process.fork().
 */
import { scorePackage } from "../src/package-scorer.js";

interface WorkerTask {
  spec: string;
  typesVersion?: string;
  domain?: string;
}

process.on("message", (task: WorkerTask) => {
  try {
    const result = scorePackage(task.spec, {
      domain: task.domain,
      typesVersion: task.typesVersion,
    });
    process.send!({ error: null, result, spec: task.spec });
  } catch (error) {
    process.send!({ error: String(error), result: null, spec: task.spec });
  }
});

// Signal ready
process.send!({ ready: true });
