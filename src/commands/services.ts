import { listRegisteredServices } from "../mcp/registry.js";
import { ensureBuiltinServices } from "../mcp/builtins.js";

export async function listServices(): Promise<void> {
  ensureBuiltinServices();
  const services = listRegisteredServices();

  if (services.length === 0) {
    console.log("No services registered.");
    return;
  }

  console.log("Registered services:");
  for (const svc of services) {
    const toolNames = svc.tools.map((t) => t.name).join(", ");
    console.log(
      `  ${svc.name} (${svc.origin}, ${svc.status}) — tools: ${toolNames || "none"}`,
    );
  }
}
