/**
 * Deno Deploy runtime entrypoint.
 *
 * During the build, Deploy executes the dynamic entrypoint to cache the
 * dependency graph. The build context has no DENO_TIMELINE, while actual
 * runtime timelines expose production/preview/branch values. Keep the build
 * probe alive without starting the application.
 */
const timeline = (Deno.env.get("DENO_TIMELINE") || "").trim();
const isBuildProbe = timeline.length === 0;

if (isBuildProbe) {
  const port = Number(Deno.env.get("PORT") || 8000);
  console.log("Filtra.IA build probe: lightweight listener started.");
  Deno.serve({ port, hostname: "0.0.0.0" }, () =>
    new Response("Filtra.IA build probe", { status: 200 }),
  );
} else {
  const { startServer } = await import("./server.ts");
  startServer().catch((e) => {
    console.error(e);
    Deno.exit(1);
  });
}
