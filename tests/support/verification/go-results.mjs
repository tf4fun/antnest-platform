export class GoResults {
  summary = { packages: 0, tests: 0, subtests: 0, skipped: 0, failed: 0 };
  skipped = [];
  output = new Map();

  accept(event, report) {
    const key = `${event.Package}/${event.Test ?? ""}`;
    if (event.Output) {
      const lines = this.output.get(key) ?? [];
      lines.push(event.Output.trimEnd());
      if (lines.length > 40) lines.shift();
      this.output.set(key, lines);
    }
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
    }
    if (["pass", "skip", "fail"].includes(event.Action))
      this.output.delete(key);
  }
}
