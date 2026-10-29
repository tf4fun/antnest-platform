const milliseconds = (seconds) =>
  Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;

export class GoResults {
  summary = { packages: 0, tests: 0, subtests: 0, skipped: 0, failed: 0 };
  skipped = [];
  output = new Map();
  packages = [];
  tests = [];
  running = new Map();
  identified = new Set();

  // Progress keeps only package paths, top-level source test names and
  // timings; subtest names may carry runtime inputs and output is never kept.
  accept(event, report, identify = () => {}, now = Date.now()) {
    const key = `${event.Package}/${event.Test ?? ""}`;
    const topLevel = event.Test && !event.Test.includes("/");
    if (event.Output) {
      const lines = this.output.get(key) ?? [];
      lines.push(event.Output.trimEnd());
      if (lines.length > 40) lines.shift();
      this.output.set(key, lines);
    }
    if (event.Action === "start")
      this.running.set(event.Package, { started: now, tests: new Map() });
    if (event.Action === "run" && topLevel)
      this.running.get(event.Package)?.tests.set(event.Test, now);
    if (event.Action === "pass") {
      this.summary[
        event.Test
          ? event.Test.includes("/")
            ? "subtests"
            : "tests"
          : "packages"
      ]++;
    }
    if (event.Action === "skip" && event.Test) {
      this.summary.skipped++;
      this.skipped.push(`${event.Package}/${event.Test}`);
    }
    if (event.Action === "fail") {
      this.summary.failed++;
      report((this.output.get(key) ?? [key]).join("\n"));
      if (event.Test)
        this.identify(event.Package, event.Test.split("/")[0], identify);
    }
    if (["pass", "skip", "fail"].includes(event.Action)) {
      this.output.delete(key);
      const result = {
        result: event.Action,
        elapsed_ms: milliseconds(event.Elapsed),
      };
      if (!event.Test) {
        this.running.delete(event.Package);
        this.packages.push({ package: event.Package, ...result });
      } else if (topLevel) {
        this.running.get(event.Package)?.tests.delete(event.Test);
        this.tests.push({
          package: event.Package,
          name: event.Test,
          ...result,
        });
      }
    }
  }

  identify(packagePath, test, identify) {
    const key = `${packagePath}\0${test}`;
    if (this.identified.has(key)) return;
    this.identified.add(key);
    identify({ Action: "fail", Package: packagePath, Test: test });
  }

  identifyRunning(identify) {
    for (const [packagePath, { tests }] of this.running)
      for (const test of tests.keys())
        this.identify(packagePath, test, identify);
  }

  // With -p=1, Go links each test binary just before running it: any interval
  // without a running package is build time.
  progress(now = Date.now()) {
    return {
      phase: this.running.size ? "test" : "build",
      packages: this.packages,
      running: [...this.running].map(([packagePath, { started, tests }]) => ({
        package: packagePath,
        elapsed_ms: now - started,
        tests: [...tests].map(([name, at]) => ({
          name,
          elapsed_ms: now - at,
        })),
      })),
      slowest_tests: [...this.tests]
        .sort((a, b) => (b.elapsed_ms ?? 0) - (a.elapsed_ms ?? 0))
        .slice(0, 10),
    };
  }
}
