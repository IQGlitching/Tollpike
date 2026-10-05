// A port the OS reports as free right now. Test files that start the gateway
// used to hardcode one (20777, 20791...), so a second copy of the same file,
// another checkout, a parallel CI job or a leftover server made every test in
// it fail with EADDRINUSE. Asking the OS removes the collision; the tiny window
// between closing this probe and the gateway binding is not a practical race.

import net from "node:net";

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
