#!/usr/bin/env node

import { main } from "./cli/commands.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  if (process.env.DEBUG_SPECIFYR === "1" && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
