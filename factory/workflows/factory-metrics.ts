import { Metrics, Outcome, rollup } from "./lib/metrics.ts";
import { readAll } from "./lib/records.ts";

const { workflow, step, skip, daily, store, Tick } = T3;
const METRICS_WINDOW_DAYS = 30;

export default workflow(
  "factory-metrics",
  { version: 1, payload: Tick, returns: Metrics, triggers: [daily("05:00")] },
  Effect.fn(function* (tick) {
    const result = yield* step(
      "rollup",
      { returns: Schema.NullOr(Metrics) },
      Effect.gen(function* () {
        const rows = yield* readAll("factory/v1/outcome/", Outcome);
        if (rows.length === 0) return null;
        const to = tick.scheduledAt;
        const from = new Date(Date.parse(to) - METRICS_WINDOW_DAYS * 86_400_000).toISOString();
        const metrics = rollup(
          rows.map((row) => row.value),
          { from, to },
        );
        yield* store.entry(`factory/v1/metrics/${to.slice(0, 10)}`, Metrics).set(metrics);
        return metrics;
      }),
    );
    return result === null ? yield* skip("no outcomes") : result;
  }),
);
