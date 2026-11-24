import type { Metadata } from "next";

import "./base.css";
import "./ambient.css";
import "./fonts.css";

import { Ambient } from "../components/ambient";

export const metadata: Metadata = {
  title: "SynthForge · Generative Synthetic Assets on GenLayer",
  description:
    "AI-generated synthetic asset portfolios where every proposal, fill and challenge is executed by GenLayer validators and anchored as an execution proof.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Ambient />
        {children}
      </body>
    </html>
  );
}
