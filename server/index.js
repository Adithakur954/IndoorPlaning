import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

if (existsSync(".env")) loadEnvFile(".env");

const { app } = await import("./app.js");
const { projectStore } = await import("./repositories/projectRepository.js");
projectStore(); // Migrate before accepting requests.

const port = Number(process.env.PORT) || 3001;
app.listen(port, "127.0.0.1", (error) => {
  if (error) {
    console.error(
      `Indoor Planner API could not use port ${port}: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Indoor Planner API: http://127.0.0.1:${port}`);
});
