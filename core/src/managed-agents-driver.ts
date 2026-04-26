import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  ORCHESTRATOR_PROTOCOL,
  resolveRunModelId,
  resolveRunModelSpeed,
} from "./simulator-config";
import type { SupportedModelId, SupportedModelSpeed } from "./simulator-config";
import type {
  Actor,
  ActorSession,
  RunInput,
} from "./schema";
import {
  buildInteractionEvaluationPrompt,
  buildSimulationAgentSystem,
  buildTurnPrompt,
} from "./agents/prompts";
import type {
  AgentDriver,
  AgentDriverSetup,
  InteractionEvaluationRequest,
  InteractionEvaluationResponse,
  AgentTurnRequest,
  AgentTurnResponse,
} from "./agents/types";

export type ManagedAgentsDriverConfig = {
  environmentId: string;
  focusActorAgentId?: string;
  defaultActorAgentId?: string;
  protagonistAgentId?: string;
  supportingAgentId?: string;
  agentIdsByActor?: Record<string, string>;
  apiKey?: string;
  worldMemoryStoreId?: string;
  runContextMemoryStoreId?: string;
  actorMemoryStoreIds?: Record<string, string>;
  relationshipMemoryStoreIds?: Record<string, string>;
  defaultActorMemoryStoreId?: string;
  defaultRelationshipMemoryStoreId?: string;
  signal?: AbortSignal;
};

type MemoryResource = {
  type: "memory_store";
  memory_store_id: string;
  access: "read_write" | "read_only";
  instructions?: string;
};

type ManagedMemoryStore = Awaited<ReturnType<Anthropic["beta"]["memoryStores"]["retrieve"]>>;

export class AnthropicManagedAgentsDriver implements AgentDriver {
  private readonly client: Anthropic;
  private readonly sessionsByActor = new Map<string, ActorSession>();

  constructor(private readonly config: ManagedAgentsDriverConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async setup(args: {
    runId: string;
    input: RunInput;
    actors: Actor[];
  }): Promise<AgentDriverSetup> {
    this.throwIfAborted();
    const actorSessions = await Promise.all(args.actors.map(async (actor): Promise<ActorSession> => {
      this.throwIfAborted();
      const memoryStoreId = await this.resolveActorMemoryStore(args.runId, actor);
      const relationshipMemoryStoreId = await this.resolveRelationshipMemoryStore(args.runId, actor);
      const resources = this.buildResources(memoryStoreId, relationshipMemoryStoreId);
      const session = await this.client.beta.sessions.create({
        agent: this.resolveAgentId(actor),
        environment_id: this.config.environmentId,
        title: `YUME ${args.runId} ${actor.id}`,
        metadata: {
          yume_run_id: args.runId,
          yume_actor_id: actor.id,
          yume_role: actor.role,
        },
        resources,
      }, this.requestOptions());
      return {
        actor_id: actor.id,
        agent_id: session.agent.id,
        session_id: session.id,
        memory_store_id: memoryStoreId,
        world_memory_store_id: this.config.worldMemoryStoreId,
        run_context_memory_store_id: this.config.runContextMemoryStoreId,
        relationship_memory_store_id: relationshipMemoryStoreId,
      };
    }));
    for (const actorSession of actorSessions) {
      this.sessionsByActor.set(actorSession.actor_id, actorSession);
    }
    return {
      environmentId: this.config.environmentId,
      actorSessions,
    };
  }

  async requestTurn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.throwIfAborted();
    const session = this.sessionsByActor.get(request.agent_id);
    if (!session) throw new Error(`No Managed Agents session for actor ${request.agent_id}`);

    const stream = await this.client.beta.sessions.events.stream(session.session_id, {}, this.requestOptions());
    await this.client.beta.sessions.events.send(session.session_id, {
      events: [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: buildTurnPrompt(request),
            },
          ],
        },
      ],
    }, this.requestOptions());

    let responseText = "";
    const observedMemoryWrites: NonNullable<AgentTurnResponse["observed_memory_writes"]> = [];
    for await (const event of stream) {
      this.throwIfAborted();
      const type = readEventType(event);
      if (type === "agent.message") {
        responseText += extractMessageText(event);
      }
      if (type === "agent.tool_use" || type === "agent.tool_result") {
        const write = extractMemoryWriteObservation(event);
        if (write) observedMemoryWrites.push(write);
      }
      if (type === "session.error") {
        if (isRetryingSessionError(event)) continue;
        throw new Error(`Managed Agents session error: ${JSON.stringify(event)}`);
      }
      if (type === "session.status_idle") {
        const stopReason = readStopReasonType(event);
        if (stopReason === "requires_action") {
          throw new Error("Managed Agents session requested an unsupported action");
        }
        break;
      }
    }

    const response = parseAgentResponse(responseText);
    if (response.run_id !== request.run_id || response.turn_id !== request.turn_id) {
      throw new Error(
        `Stale Managed Agents response: expected ${request.run_id}/${request.turn_id}, got ${response.run_id}/${response.turn_id}`,
      );
    }
    if (observedMemoryWrites.length > 0) {
      response.observed_memory_writes = observedMemoryWrites;
    }
    return response;
  }

  async recordMemoryUpdate(args: {
    memoryStoreId: string;
    memoryPath: string;
    content: string;
  }): Promise<{ memoryVersionId: string }> {
    this.throwIfAborted();
    const memory = await this.createOrUpdateMemoryWithPrecondition(
      args.memoryStoreId,
      args.memoryPath,
      args.content,
    );
    return { memoryVersionId: memory.memory_version_id };
  }

  async evaluateInteraction(request: InteractionEvaluationRequest): Promise<InteractionEvaluationResponse> {
    this.throwIfAborted();
    const session = this.sessionsByActor.get(request.initiator_actor_id)
      ?? this.sessionsByActor.get(request.target_actor_id);
    if (!session) {
      throw new Error(`No Managed Agents session for interaction evaluator ${request.initiator_actor_id}/${request.target_actor_id}`);
    }

    const stream = await this.client.beta.sessions.events.stream(session.session_id, {}, this.requestOptions());
    await this.client.beta.sessions.events.send(session.session_id, {
      events: [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: buildInteractionEvaluationPrompt(request),
            },
          ],
        },
      ],
    }, this.requestOptions());

    let responseText = "";
    for await (const event of stream) {
      this.throwIfAborted();
      const type = readEventType(event);
      if (type === "agent.message") {
        responseText += extractMessageText(event);
      }
      if (type === "session.error") {
        if (isRetryingSessionError(event)) continue;
        throw new Error(`Managed Agents evaluator session error: ${JSON.stringify(event)}`);
      }
      if (type === "session.status_idle") {
        const stopReason = readStopReasonType(event);
        if (stopReason === "requires_action") {
          throw new Error("Managed Agents evaluator requested an unsupported action");
        }
        break;
      }
    }

    const response = parseInteractionEvaluationResponse(responseText);
    if (response.run_id !== request.run_id || response.turn_id !== request.turn_id) {
      throw new Error(
        `Stale interaction evaluation: expected ${request.run_id}/${request.turn_id}, got ${response.run_id}/${response.turn_id}`,
      );
    }
    return response;
  }

  private resolveAgentId(actor: Actor): string {
    const focusDefault = this.config.focusActorAgentId ?? this.config.protagonistAgentId;
    const actorDefault = this.config.defaultActorAgentId ?? this.config.supportingAgentId ?? focusDefault;
    if (!actorDefault) throw new Error("A default Managed Agent id is required");
    return this.config.agentIdsByActor?.[actor.id]
      ?? (actor.is_focus && focusDefault ? focusDefault : actorDefault);
  }

  private async resolveActorMemoryStore(runId: string, actor: Actor): Promise<string> {
    const configured = this.config.actorMemoryStoreIds?.[actor.id];
    if (configured) return configured;
    if (this.config.defaultActorMemoryStoreId) return this.config.defaultActorMemoryStoreId;
    const store = await this.client.beta.memoryStores.create({
      name: `YUME ${runId} ${actor.id}`,
      description: `Subjective memory for YUME actor ${actor.display_name}.`,
      metadata: {
        yume_run_id: runId,
        yume_actor_id: actor.id,
      },
    }, this.requestOptions());
    return store.id;
  }

  private async resolveRelationshipMemoryStore(runId: string, actor: Actor): Promise<string> {
    const configured = this.config.relationshipMemoryStoreIds?.[actor.id];
    if (configured) return configured;
    if (this.config.defaultRelationshipMemoryStoreId) return this.config.defaultRelationshipMemoryStoreId;
    const store = await this.client.beta.memoryStores.create({
      name: `YUME ${runId} ${actor.id} relationships`,
      description: `Subjective relationship notes for YUME actor ${actor.display_name}.`,
      metadata: {
        yume_run_id: runId,
        yume_actor_id: actor.id,
        yume_memory_kind: "relationship_notes",
      },
    }, this.requestOptions());
    return store.id;
  }

  private buildResources(actorMemoryStoreId: string, relationshipMemoryStoreId: string): MemoryResource[] {
    const resources: MemoryResource[] = [];
    const pushResource = (resource: MemoryResource) => {
      const existing = resources.find((candidate) => candidate.memory_store_id === resource.memory_store_id);
      if (existing) {
        if (resource.access === "read_write") existing.access = "read_write";
        if (resource.instructions && existing.instructions !== resource.instructions) {
          existing.instructions = [existing.instructions, resource.instructions].filter(Boolean).join(" ");
        }
        return;
      }
      resources.push(resource);
    };
    if (this.config.worldMemoryStoreId) {
      pushResource({
        type: "memory_store",
        memory_store_id: this.config.worldMemoryStoreId,
        access: "read_only",
        instructions: "Shared world reference. Read /rules/simulation.md as soft rules. Never treat this store as the source of current numeric state.",
      });
    }
    if (this.config.runContextMemoryStoreId) {
      pushResource({
        type: "memory_store",
        memory_store_id: this.config.runContextMemoryStoreId,
        access: "read_only",
        instructions: "Run-level reference material. Current clock and state come from each turn envelope.",
      });
    }
    pushResource({
      type: "memory_store",
      memory_store_id: actorMemoryStoreId,
      access: "read_write",
      instructions: "Subjective actor memory only. Do not store objective money, stress, health, or clock values.",
    });
    pushResource({
      type: "memory_store",
      memory_store_id: relationshipMemoryStoreId,
      access: "read_write",
      instructions: "Subjective relationship notes only. Write only this actor's own interpretation of other actors.",
    });
    return resources;
  }

  private async createOrUpdateMemoryWithPrecondition(
    memoryStoreId: string,
    path: string,
    content: string,
  ) {
    this.throwIfAborted();
    const existing = await this.findMemoryByPath(memoryStoreId, path);
    if (!existing) {
      return await this.client.beta.memoryStores.memories.create(memoryStoreId, {
        path,
        content,
      }, this.requestOptions());
    }

    for (let attempt = 0; attempt <= 2; attempt++) {
      this.throwIfAborted();
      const latest = attempt === 0
        ? await this.client.beta.memoryStores.memories.retrieve(existing.id, {
            memory_store_id: memoryStoreId,
            view: "full",
          }, this.requestOptions())
        : await this.client.beta.memoryStores.memories.retrieve(existing.id, {
            memory_store_id: memoryStoreId,
            view: "full",
          }, this.requestOptions());
      const previousContent = latest.content ?? "";
      const nextContent = mergeMemoryContent(previousContent, content);
      try {
        return await this.client.beta.memoryStores.memories.update(existing.id, {
          memory_store_id: memoryStoreId,
          content: nextContent,
          precondition: {
            type: "content_sha256",
            content_sha256: latest.content_sha256,
          },
        }, this.requestOptions());
      } catch (error) {
        if (!isPreconditionFailure(error) || attempt >= 2) throw error;
      }
    }
    throw new Error(`Failed to update memory with precondition: ${path}`);
  }

  private async findMemoryByPath(memoryStoreId: string, path: string) {
    for await (const item of this.client.beta.memoryStores.memories.list(memoryStoreId, {
      path_prefix: path,
      depth: 1,
      order_by: "path",
      view: "basic",
    }, this.requestOptions())) {
      this.throwIfAborted();
      if (item.type === "memory" && item.path === path) return item;
    }
    return undefined;
  }

  private requestOptions() {
    return this.config.signal ? { signal: this.config.signal } : undefined;
  }

  private throwIfAborted(): void {
    if (!this.config.signal?.aborted) return;
    throw abortErrorFromSignal(this.config.signal);
  }
}

type CreateManagedAgentsDriverOptions = {
  signal?: AbortSignal;
  modelId?: string | null;
  modelSpeed?: string | null;
};

type ManagedAgentsRegistryShared = {
  environmentId?: string;
  worldMemoryStoreId?: string;
  runContextMemoryStoreId?: string;
  defaultActorMemoryStoreId?: string;
  defaultRelationshipMemoryStoreId?: string;
};

type ManagedAgentsRegistryProfile = {
  modelId: SupportedModelId;
  speed: SupportedModelSpeed;
  focusActorAgentId: string;
  defaultActorAgentId: string;
  createdAt: string;
  updatedAt: string;
};

type ManagedAgentsRegistry = {
  version: 1;
  shared: ManagedAgentsRegistryShared;
  profiles: Record<string, ManagedAgentsRegistryProfile>;
};

type ManagedAgentsResolvedResources = ManagedAgentsRegistryShared & {
  environmentId: string;
  focusActorAgentId: string;
  defaultActorAgentId: string;
};

export type ManagedAgentsLocalSetup = ManagedAgentsResolvedResources & {
  registryPath: string;
  profileKey: string;
  modelId: SupportedModelId;
  modelSpeed: SupportedModelSpeed;
};

const MANAGED_AGENTS_REGISTRY_PATH = join(import.meta.dirname, "..", "data", "managed-agents.json");

export async function createManagedAgentsDriverFromEnv(
  options: CreateManagedAgentsDriverOptions = {},
): Promise<AnthropicManagedAgentsDriver> {
  const modelId = resolveRunModelId(options.modelId);
  const modelSpeed = resolveRunModelSpeed(options.modelSpeed);
  const resources = await resolveManagedAgentsResources({ modelId, speed: modelSpeed, signal: options.signal });
  return new AnthropicManagedAgentsDriver({
    environmentId: resources.environmentId,
    focusActorAgentId: resources.focusActorAgentId,
    defaultActorAgentId: resources.defaultActorAgentId,
    worldMemoryStoreId: resources.worldMemoryStoreId,
    runContextMemoryStoreId: resources.runContextMemoryStoreId,
    relationshipMemoryStoreIds: parseJsonRecord(process.env.YUME_RELATIONSHIP_MEMORY_STORE_IDS_JSON),
    actorMemoryStoreIds: parseJsonRecord(process.env.YUME_ACTOR_MEMORY_STORE_IDS_JSON),
    defaultActorMemoryStoreId: resources.defaultActorMemoryStoreId,
    defaultRelationshipMemoryStoreId: resources.defaultRelationshipMemoryStoreId,
    signal: options.signal,
  });
}

export async function setupManagedAgentsRegistry(
  options: { modelId?: string | null; modelSpeed?: string | null } = {},
): Promise<ManagedAgentsLocalSetup> {
  const modelId = resolveRunModelId(options.modelId);
  const modelSpeed = resolveRunModelSpeed(options.modelSpeed);
  const resources = await resolveManagedAgentsResources({ modelId, speed: modelSpeed });
  return {
    ...resources,
    registryPath: MANAGED_AGENTS_REGISTRY_PATH,
    profileKey: managedAgentsProfileKey(modelId, modelSpeed),
    modelId,
    modelSpeed,
  };
}


async function resolveManagedAgentsResources(args: {
  modelId: SupportedModelId;
  speed: SupportedModelSpeed;
  signal?: AbortSignal;
}): Promise<ManagedAgentsResolvedResources> {
  requiredEnv("ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tag = `yume-${Date.now()}`;
  const registry = readManagedAgentsRegistry();
  let changed = await ensureSharedResourcesInRegistry(client, registry, tag, args.signal);
  const profileKey = managedAgentsProfileKey(args.modelId, args.speed);
  let profile = registry.profiles[profileKey];

  if (profile && !await profileUsesModel(client, profile, args.modelId, args.speed)) {
    profile = undefined;
  }

  if (!profile) {
    profile = await resolveReusableProfileFromEnv(client, args.modelId, args.speed)
      ?? await createManagedAgentsProfile(client, args.modelId, args.speed, tag, args.signal);
    registry.profiles[profileKey] = profile;
    changed = true;
  }

  if (changed) saveManagedAgentsRegistry(registry);

  return {
    environmentId: registry.shared.environmentId!,
    focusActorAgentId: profile.focusActorAgentId,
    defaultActorAgentId: profile.defaultActorAgentId,
    worldMemoryStoreId: registry.shared.worldMemoryStoreId,
    runContextMemoryStoreId: registry.shared.runContextMemoryStoreId,
    defaultActorMemoryStoreId: registry.shared.defaultActorMemoryStoreId,
    defaultRelationshipMemoryStoreId: registry.shared.defaultRelationshipMemoryStoreId,
  };
}

async function ensureSharedResourcesInRegistry(
  client: Anthropic,
  registry: ManagedAgentsRegistry,
  tag: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let changed = false;
  const shared = registry.shared;

  if (!shared.environmentId) {
    shared.environmentId = process.env.YUME_MANAGED_AGENTS_ENVIRONMENT_ID
      ?? (await createManagedAgentsEnvironment(client, tag, signal)).id;
    changed = true;
  }

  let sharedMemory: ManagedMemoryStore | undefined;
  const getSharedMemory = async () => {
    sharedMemory ??= await resolveSharedMemoryStore(client, tag);
    return sharedMemory;
  };

  const memoryMappings: Array<{ key: keyof ManagedAgentsRegistryShared; envName: string }> = [
    { key: "worldMemoryStoreId", envName: "YUME_WORLD_MEMORY_STORE_ID" },
    { key: "runContextMemoryStoreId", envName: "YUME_RUN_CONTEXT_MEMORY_STORE_ID" },
    { key: "defaultActorMemoryStoreId", envName: "YUME_DEFAULT_ACTOR_MEMORY_STORE_ID" },
    { key: "defaultRelationshipMemoryStoreId", envName: "YUME_DEFAULT_RELATIONSHIP_MEMORY_STORE_ID" },
  ];

  for (const mapping of memoryMappings) {
    if (shared[mapping.key]) continue;
    shared[mapping.key] = process.env[mapping.envName] ?? (await getSharedMemory()).id;
    changed = true;
  }

  return changed;
}

async function createManagedAgentsEnvironment(
  client: Anthropic,
  tag: string,
  signal?: AbortSignal,
) {
  return client.beta.environments.create({
    name: `YUME simulator ${tag}`,
    description: "YUME simulator Managed Agents environment.",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: [],
        allow_mcp_servers: false,
        allow_package_managers: false,
      },
      packages: { type: "packages", apt: [], npm: [], pip: [] },
    },
    metadata: { yume_resource: "simulator", yume_tag: tag },
  }, signal ? { signal } : undefined);
}

async function profileUsesModel(
  client: Anthropic,
  profile: ManagedAgentsRegistryProfile,
  modelId: SupportedModelId,
  speed: SupportedModelSpeed,
): Promise<boolean> {
  return await agentUsesModel(client, profile.focusActorAgentId, modelId, speed) &&
    await agentUsesModel(client, profile.defaultActorAgentId, modelId, speed);
}

async function resolveReusableProfileFromEnv(
  client: Anthropic,
  modelId: SupportedModelId,
  speed: SupportedModelSpeed,
): Promise<ManagedAgentsRegistryProfile | undefined> {
  const focusActorAgentId = process.env.YUME_FOCUS_ACTOR_AGENT_ID ?? process.env.YUME_PROTAGONIST_AGENT_ID;
  const defaultActorAgentId = process.env.YUME_DEFAULT_ACTOR_AGENT_ID ?? process.env.YUME_SUPPORTING_AGENT_ID;
  if (!focusActorAgentId || !defaultActorAgentId) return undefined;
  const focusMatches = await agentUsesModel(client, focusActorAgentId, modelId, speed);
  const defaultMatches = await agentUsesModel(client, defaultActorAgentId, modelId, speed);
  if (!focusMatches || !defaultMatches) return undefined;
  const now = new Date().toISOString();
  return {
    modelId,
    speed,
    focusActorAgentId,
    defaultActorAgentId,
    createdAt: now,
    updatedAt: now,
  };
}

async function createManagedAgentsProfile(
  client: Anthropic,
  modelId: SupportedModelId,
  speed: SupportedModelSpeed,
  tag: string,
  signal?: AbortSignal,
): Promise<ManagedAgentsRegistryProfile> {
  const focusAgent = await createSimulationAgent(client, "focus", modelId, speed, tag, signal);
  const defaultAgent = await createSimulationAgent(client, "default", modelId, speed, tag, signal);
  const now = new Date().toISOString();
  return {
    modelId,
    speed,
    focusActorAgentId: focusAgent.id,
    defaultActorAgentId: defaultAgent.id,
    createdAt: now,
    updatedAt: now,
  };
}

function managedAgentsProfileKey(modelId: SupportedModelId, speed: SupportedModelSpeed): string {
  return `${modelId}__${speed}`;
}

function readManagedAgentsRegistry(): ManagedAgentsRegistry {
  if (!existsSync(MANAGED_AGENTS_REGISTRY_PATH)) {
    return { version: 1, shared: {}, profiles: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(MANAGED_AGENTS_REGISTRY_PATH, "utf8")) as unknown;
    if (!isRecord(parsed)) return { version: 1, shared: {}, profiles: {} };
    const shared = isRecord(parsed.shared) ? parsed.shared as ManagedAgentsRegistryShared : {};
    const rawProfiles = isRecord(parsed.profiles) ? parsed.profiles : {};
    const profiles: Record<string, ManagedAgentsRegistryProfile> = {};
    for (const [key, value] of Object.entries(rawProfiles)) {
      if (isManagedAgentsProfile(value)) profiles[key] = value;
    }
    return { version: 1, shared, profiles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Managed Agents registry at ${MANAGED_AGENTS_REGISTRY_PATH}: ${message}`);
  }
}

function saveManagedAgentsRegistry(registry: ManagedAgentsRegistry): void {
  mkdirSync(dirname(MANAGED_AGENTS_REGISTRY_PATH), { recursive: true });
  writeFileSync(MANAGED_AGENTS_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isManagedAgentsProfile(value: unknown): value is ManagedAgentsRegistryProfile {
  if (!isRecord(value)) return false;
  return typeof value.modelId === "string" &&
    typeof value.speed === "string" &&
    typeof value.focusActorAgentId === "string" &&
    typeof value.defaultActorAgentId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

async function agentUsesModel(
  client: Anthropic,
  agentId: string | undefined,
  expectedModelId: SupportedModelId,
  expectedSpeed: SupportedModelSpeed,
): Promise<boolean> {
  if (!agentId) return false;
  try {
    const agent = await client.beta.agents.retrieve(agentId);
    const model = readAgentModelConfig(agent.model);
    return model?.id === expectedModelId && modelSpeedMatches(model.speed, expectedSpeed);
  } catch {
    return false;
  }
}

function readAgentModelConfig(model: unknown): { id: string; speed?: string | null } | undefined {
  if (typeof model === "string") return { id: model };
  if (!model || typeof model !== "object") return undefined;
  const record = model as Record<string, unknown>;
  const id = record.id;
  const nestedModel = record.model;
  const resolvedId = typeof id === "string" ? id : typeof nestedModel === "string" ? nestedModel : undefined;
  if (!resolvedId) return undefined;
  const speed = record.speed;
  return { id: resolvedId, speed: typeof speed === "string" ? speed : null };
}

function modelSpeedMatches(actualSpeed: string | null | undefined, expectedSpeed: SupportedModelSpeed): boolean {
  if (expectedSpeed === "standard") return !actualSpeed || actualSpeed === "standard";
  return actualSpeed === expectedSpeed;
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(typeof signal.reason === "string" ? signal.reason : "Run cancelled");
}

async function resolveSharedMemoryStore(
  client: Anthropic,
  tag: string,
): Promise<ManagedMemoryStore> {
  const reusable = await findReusableMemoryStore(client);
  if (reusable) {
    await ensureSharedReferenceMemories(client, reusable.id);
    return reusable;
  }

  const store = await client.beta.memoryStores.create({
    name: `YUME simulator memory ${tag}`,
    description: "Shared YUME simulator memory store.",
    metadata: { yume_resource: "simulator_memory", yume_tag: tag },
  });
  await ensureSharedReferenceMemories(client, store.id);
  return store;
}

async function ensureSharedReferenceMemories(client: Anthropic, memoryStoreId: string): Promise<void> {
  await upsertReferenceMemory(client, memoryStoreId, "/rules/simulation.md", [
    "# YUME simulation rules",
    "",
    "- The orchestrator owns objective time, world state, commits, and event logs.",
    "- Agent sessions choose from the offered actions only.",
    "- Other actors' hidden numeric state appears only as observed hints.",
    "- Memory stores contain subjective memory, not objective current state.",
    "- Character behavior traits are soft fictional simulation heuristics, not diagnoses.",
  ].join("\n"));
}

async function upsertReferenceMemory(
  client: Anthropic,
  memoryStoreId: string,
  path: string,
  content: string,
) {
  const existing = await findMemoryByPath(client, memoryStoreId, path);
  if (!existing) {
    return await client.beta.memoryStores.memories.create(memoryStoreId, { path, content });
  }
  const latest = await client.beta.memoryStores.memories.retrieve(existing.id, {
    memory_store_id: memoryStoreId,
    view: "full",
  });
  if ((latest.content ?? "").trim() === content.trim()) return latest;
  return await client.beta.memoryStores.memories.update(existing.id, {
    memory_store_id: memoryStoreId,
    content,
    precondition: {
      type: "content_sha256",
      content_sha256: latest.content_sha256,
    },
  });
}

async function findMemoryByPath(client: Anthropic, memoryStoreId: string, path: string) {
  for await (const item of client.beta.memoryStores.memories.list(memoryStoreId, { limit: 100 })) {
    if (item.type === "memory" && item.path === path) return item;
  }
  return undefined;
}

async function findReusableMemoryStore(client: Anthropic): Promise<ManagedMemoryStore | undefined> {
  for await (const store of client.beta.memoryStores.list({ limit: 100 })) {
    if (store.archived_at) continue;
    const resource = store.metadata?.yume_resource;
    if (resource === "simulator_memory" || resource === "shared_reference") return store;
    if (/^YUME\b/i.test(store.name)) return store;
  }
  return undefined;
}

async function createSimulationAgent(
  client: Anthropic,
  role: "focus" | "default",
  model: SupportedModelId,
  speed: SupportedModelSpeed,
  tag: string,
  signal?: AbortSignal,
) {
  return client.beta.agents.create({
    name: `YUME ${role} actor ${tag}`,
    model: { id: model, speed },
    description: `YUME ${role} actor agent.`,
    system: buildSimulationAgentSystem(),
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: false,
          permission_policy: { type: "always_allow" },
        },
        configs: [
          { name: "read", enabled: true, permission_policy: { type: "always_allow" } },
          { name: "write", enabled: true, permission_policy: { type: "always_allow" } },
        ],
      },
    ],
    metadata: { yume_resource: "actor_agent", yume_role: role, yume_tag: tag, yume_model: model, yume_speed: speed },
  }, signal ? { signal } : undefined);
}

function parseJsonRecord(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return Object.fromEntries(
    Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function mergeMemoryContent(previousContent: string, nextEntry: string): string {
  const trimmedPrevious = previousContent.trim();
  const trimmedNext = nextEntry.trim();
  if (!trimmedPrevious) return `${trimmedNext}\n`;
  if (trimmedPrevious.includes(trimmedNext)) return `${trimmedPrevious}\n`;
  return `${trimmedPrevious}\n\n${trimmedNext}\n`;
}

function isPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const status = record.status;
  const type = typeof record.type === "string" ? record.type : undefined;
  const errorBody = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : undefined;
  return status === 409 ||
    type === "memory_precondition_failed_error" ||
    errorBody?.type === "memory_precondition_failed_error";
}

function parseAgentResponse(text: string): AgentTurnResponse {
  const candidate = extractJsonObject(text);
  const parsed = JSON.parse(candidate) as AgentTurnResponse;
  if (parsed.type !== "yume.agent_response") {
    throw new Error(`Invalid Managed Agents response type: ${parsed.type}`);
  }
  return parsed;
}

function parseInteractionEvaluationResponse(text: string): InteractionEvaluationResponse {
  const candidate = extractJsonObject(text);
  const parsed = JSON.parse(candidate) as InteractionEvaluationResponse;
  if (parsed.type !== "yume.interaction_evaluation") {
    throw new Error(`Invalid interaction evaluation response type: ${parsed.type}`);
  }
  return parsed;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("Managed Agents response did not contain JSON");
}

function extractMessageText(event: unknown): string {
  const content = readArrayProperty(event, "content");
  return content
    .map((block) => readTextBlock(block))
    .filter((text) => text.length > 0)
    .join("");
}

function extractMemoryWriteObservation(
  event: unknown,
): NonNullable<AgentTurnResponse["observed_memory_writes"]>[number] | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const serialized = JSON.stringify(record);
  if (!/(write|edit|memory|memstore|\/mnt\/memory)/i.test(serialized)) return undefined;
  const path = extractStringField(record, ["path", "file_path", "target_file"]);
  return {
    tool_name: name,
    path,
  };
}

function extractStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  const input = record.input;
  if (input && typeof input === "object") {
    return extractStringField(input as Record<string, unknown>, keys);
  }
  return undefined;
}

function readTextBlock(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text : "";
}

function readEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = (event as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

function isRetryingSessionError(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const error = (event as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return false;
  const retryStatus = (error as Record<string, unknown>).retry_status;
  if (!retryStatus || typeof retryStatus !== "object") return false;
  return (retryStatus as Record<string, unknown>).type === "retrying";
}

function readStopReasonType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const stopReason = (event as Record<string, unknown>).stop_reason;
  if (!stopReason || typeof stopReason !== "object") return undefined;
  const type = (stopReason as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

function readArrayProperty(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) ? property : [];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
