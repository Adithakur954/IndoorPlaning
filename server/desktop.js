// Packaged entry point: the Tauri launcher supplies paths and trusted settings.
import { writeFile } from "node:fs/promises";
process.env.INDOOR_LICENSE_MODE = "required";
const { app } = await import("./app.js");
const { projectStore } = await import("./repositories/projectRepository.js");
projectStore();
const server = app.listen(0, "127.0.0.1", async () => {
  try {
    await writeFile(
      process.env.DESKTOP_READY_FILE,
      JSON.stringify({ port: server.address().port }),
    );
  } catch (error) {
    console.error(error);
    server.close();
    process.exitCode = 1;
  }
});
