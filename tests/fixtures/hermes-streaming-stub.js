#!/usr/bin/env node
// Stub `hermes` CLI for tests. Args ("chat -q") are ignored.
// Reads stdin (the prompt), prints two lines on stdout, exits 0.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
});
process.stdin.on("end", () => {
  process.stdout.write("hello\n");
  process.stdout.write("world\n");
  process.exit(0);
});
