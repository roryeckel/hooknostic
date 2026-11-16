import { main } from "./main.js";

// Set the exit code and let the event loop drain: a forced process.exit()
// can truncate stdout when it is a pipe (large --json reports).
process.exitCode = await main(process.argv.slice(2));
