import "../console.css";

import { ConsoleShell } from "../../components/console-shell";
import { VaultProvider } from "../../components/vault-context";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <VaultProvider>
      <ConsoleShell>{children}</ConsoleShell>
    </VaultProvider>
  );
}
