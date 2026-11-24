import type { Metadata } from "next";

import "./base.css";
import "./fonts.css";

export const metadata: Metadata = {
  title: "SynthForge · Generative Synthetic Assets on GenLayer",
  description:
    "AI-generated synthetic asset portfolios where every proposal, fill and challenge is executed by GenLayer validators and anchored as an execution proof.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
