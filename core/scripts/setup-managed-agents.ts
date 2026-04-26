import { setupManagedAgentsRegistry } from "../src/managed-agents-driver";

const modelId = readArg("--model");
const modelSpeed = readArg("--speed");
const setup = await setupManagedAgentsRegistry({ modelId, modelSpeed });

console.log("Managed Agents configuration is ready.");
console.log(`Registry: ${setup.registryPath}`);
console.log(`Profile: ${setup.profileKey}`);
console.log(`Model: ${setup.modelId}`);
console.log(`Speed: ${setup.modelSpeed}`);
console.log(`Environment: ${setup.environmentId}`);
console.log(`Focus agent: ${setup.focusActorAgentId}`);
console.log(`Default agent: ${setup.defaultActorAgentId}`);

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = Bun.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Bun.argv.indexOf(name);
  if (index >= 0) return Bun.argv[index + 1];
  return undefined;
}
