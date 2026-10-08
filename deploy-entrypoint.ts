const isBuildProbe = Deno.env.get("CI") === "true" && Boolean(Deno.env.get("DENO_DEPLOY_BUILD_ID"));

if (isBuildProbe) {
  const port = Number(Deno.env.get("PORT") || 8000);
  console.log("Filtra.IA build probe: lightweight listener started.");
  Deno.serve({ port, hostname: "0.0.0.0" }, () => new Response("Filtra.IA build probe", { status: 200 }));
} else {
  const { startServer } = await import("./server.ts");
  startServer().catch((e) => { console.error(e); Deno.exit(1); });
}
