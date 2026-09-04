process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("stdin-eof\n"));
