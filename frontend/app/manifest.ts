import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SynthForge · Generative Synthetic Assets on GenLayer",
    short_name: "SynthForge",
    description:
      "Synthetic asset vaults whose strategies, fills and challenges are executed by GenLayer validators and anchored as execution proofs.",
    start_url: "/",
    display: "standalone",
    background_color: "#070e11",
    theme_color: "#070e11",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
