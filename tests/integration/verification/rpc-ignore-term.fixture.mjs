#!/usr/bin/env node
// Deliberately uncooperative child for the diagnostic's termination contract.
import { get } from "node:http";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
get(`${process.argv[2]}/diagnostic/clock`, (response) => response.resume());
