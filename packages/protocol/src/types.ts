export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type ProtocolVersion = `1.${number}`;
export type ProfileId = `${string}@${number}`;
export type CapabilityId = `${string}@${number}`;
export type ExtensionKey = `urn:${string}`;
export type ProtocolExtensions = Readonly<Record<ExtensionKey, JsonValue>>;
export type ProtocolId = string;
export type OperationImpact = "read" | "write" | "destructive";
export type EnvironmentKind =
  | "development" | "test" | "qa" | "staging" | "uat" | "preview" | "sandbox";

export interface EnvironmentDescriptor {
  readonly name: ProtocolId;
  readonly kind: EnvironmentKind;
}

export type JsonPointer = "" | `/${string}`;
export type JsonPointerMap = Readonly<Partial<Record<JsonPointer, JsonValue>>>;
export type Rfc3339Timestamp = string;
export type Sha256Revision = `sha256:${string}`;
export type SchemaDialect = "https://json-schema.org/draft/2020-12/schema";

export interface Extensible { readonly extensions?: ProtocolExtensions; }
export interface JsonSchema extends JsonObject { readonly $schema: SchemaDialect; }
export interface ObjectJsonSchema extends JsonSchema { readonly type: "object"; }

export type RunState = "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "expired";
export type TargetState = "online" | "offline" | "incompatible" | "degraded";
export type CoreCapabilityId =
  | "tc-uploads@1"
  | "tc-run-cancellation@1"
  | "tc-run-sse@1"
  | "tc-session-launch@1";

export interface ProtocolRequirements {
  readonly profiles?: readonly ProfileId[];
  readonly capabilities?: readonly CapabilityId[];
}

export interface Problem extends Extensible {
  readonly type: CoreProblemType | `urn:gauntlet:problem:${string}`;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly errors?: readonly ValidationError[];
  readonly capability?: CapabilityId;
}

export type CoreProblemType =
  | "urn:gauntlet:problem:adapter-disabled"
  | "urn:gauntlet:problem:unsupported-capability"
  | "urn:gauntlet:problem:operation-not-found"
  | "urn:gauntlet:problem:run-not-found"
  | "urn:gauntlet:problem:data-source-not-found"
  | "urn:gauntlet:problem:route-not-found"
  | "urn:gauntlet:problem:method-not-allowed"
  | "urn:gauntlet:problem:invalid-json"
  | "urn:gauntlet:problem:invalid-path"
  | "urn:gauntlet:problem:validation-failed"
  | "urn:gauntlet:problem:stale-operation-revision"
  | "urn:gauntlet:problem:operation-busy"
  | "urn:gauntlet:problem:run-not-cancellable"
  | "urn:gauntlet:problem:run-cancelled"
  | "urn:gauntlet:problem:run-timed-out"
  | "urn:gauntlet:problem:handler-failed"
  | "urn:gauntlet:problem:adapter-invalid-response"
  | "urn:gauntlet:problem:adapter-unavailable"
  | "urn:gauntlet:problem:adapter-internal-error";

export interface ValidationError extends Extensible {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: JsonObject;
}

export interface AdapterManifest extends Extensible {
  readonly protocolVersion: ProtocolVersion;
  readonly manifestRevision: Sha256Revision;
  readonly schemaDialect: SchemaDialect;
  readonly profiles: readonly ProfileId[];
  readonly capabilities: readonly CapabilityId[];
  readonly application: ApplicationMetadata;
  readonly features: readonly FeatureDefinition[];
  readonly operations: readonly OperationSummary[];
  readonly dataSources: readonly DataSourceDefinition[];
  readonly diagnostics?: readonly AdapterDiagnostic[];
}

export interface AdapterHealth extends Extensible {
  readonly status: "ok";
  readonly protocolVersion: ProtocolVersion;
}

export interface ApplicationMetadata extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly environment: EnvironmentDescriptor;
}

export interface FeatureDefinition extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly parentId?: ProtocolId;
  readonly order?: number;
}

export type OperationPlacement =
  | { readonly kind: "global" }
  | {
      readonly kind: "subject";
      readonly subjectType: ProtocolId;
      readonly bindings?: Readonly<Record<JsonPointer, ProtocolId>>;
    };

export interface OperationIdentity {
  readonly id: ProtocolId;
  readonly revision: Sha256Revision;
  readonly label: string;
  readonly featureId: ProtocolId;
}

export interface OperationSummary extends OperationIdentity, Extensible {
  readonly availability:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly problem: Problem };
  readonly requirements?: ProtocolRequirements;
  readonly placements?: readonly OperationPlacement[];
}

export interface AdapterDiagnostic extends Extensible {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly operationId?: ProtocolId;
}

export interface OperationDefinition extends OperationIdentity, Extensible {
  readonly description?: string;
  readonly icon?: string;
  readonly order: number;
  readonly tags: readonly string[];
  readonly requirements?: ProtocolRequirements;
  readonly placements?: readonly OperationPlacement[];
  readonly inputSchema: ObjectJsonSchema;
  readonly inputHandling?: InputHandling;
  readonly contextSchema?: ObjectJsonSchema;
  readonly uiSchema?: OperationUiSchema;
  readonly dataSources: readonly DataSourceReference[];
  readonly presets: readonly OperationPreset[];
  readonly execution: ExecutionPolicy;
  readonly output: OperationOutput;
}

export interface DataSourceReference extends Extensible {
  readonly id: ProtocolId;
  readonly inputPointer: JsonPointer;
  readonly dependencyPointers: readonly JsonPointer[];
  readonly contextPointers?: readonly JsonPointer[];
  readonly required?: boolean;
}

export interface DataSourceDefinition extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: {
    readonly search: boolean;
    readonly pagination: "cursor";
    readonly resolve: true;
    readonly defaultLimit: number;
    readonly maxLimit: number;
  };
  readonly dependencySchema?: ObjectJsonSchema;
  readonly contextSchema?: ObjectJsonSchema;
}

export type CoreWidget =
  | "text" | "textarea" | "integer" | "number" | "toggle"
  | "select" | "multi-select" | "autocomplete"
  | "date" | "date-time" | "duration"
  | "code" | "json" | "secret" | "file";

export type UiCondition =
  | { readonly op: "present"; readonly pointer: JsonPointer }
  | { readonly op: "equals"; readonly pointer: JsonPointer; readonly value: JsonValue }
  | { readonly op: "in"; readonly pointer: JsonPointer; readonly values: readonly JsonValue[] }
  | { readonly op: "all" | "any"; readonly conditions: readonly UiCondition[] }
  | { readonly op: "not"; readonly condition: UiCondition };

export type UiNode =
  | {
      readonly type: "field";
      readonly pointer: JsonPointer;
      readonly widget?: CoreWidget | `urn:${string}`;
      readonly dataSourceId?: ProtocolId;
      readonly label?: string;
      readonly help?: string;
      readonly options?: JsonObject;
      readonly visibleWhen?: UiCondition;
      readonly enabledWhen?: UiCondition;
    }
  | {
      readonly type: "group" | "columns";
      readonly label?: string;
      readonly children: readonly UiNode[];
      readonly visibleWhen?: UiCondition;
    }
  | {
      readonly type: "tabs";
      readonly tabs: readonly { readonly id: ProtocolId; readonly label: string; readonly children: readonly UiNode[] }[];
    };

export interface OperationUiSchema extends Extensible {
  readonly profile: "tc-rich-forms@1";
  readonly root: UiNode;
}

export interface OperationPreset extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly description?: string;
  readonly input: JsonObject;
  readonly lockedPointers?: readonly JsonPointer[];
}

export interface FileReference extends Extensible {
  readonly kind: "file";
  readonly uploadId: ProtocolId;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256?: Sha256Revision;
  readonly expiresAt: Rfc3339Timestamp;
}

export type InputHandlingRule =
  | { readonly kind: "secret"; readonly schemaPointer: JsonPointer; readonly retention: "none" }
  | {
      readonly kind: "file";
      readonly schemaPointer: JsonPointer;
      readonly multiple: boolean;
      readonly mediaTypes?: readonly string[];
      readonly maxBytes?: number;
    };

export interface InputHandling extends Extensible {
  readonly rules: readonly InputHandlingRule[];
}

export interface ExecutionPolicy extends Extensible {
  readonly impact: OperationImpact;
  readonly confirmationRequired: boolean;
  readonly dryRunSupported: boolean;
  readonly idempotency: "none" | "optional" | "required";
  readonly cancellationSupported: boolean;
  readonly timeoutSeconds?: number;
  readonly concurrency?: "allow" | "forbid" | "queue";
}

export interface OperationOutput extends Extensible {
  readonly schema: JsonSchema;
  readonly presentation?: {
    readonly profile: "tc-rich-results@1";
    readonly defaultView?: "summary" | "details" | "artifacts";
  };
}

export interface CreateRunRequest extends Extensible {
  readonly operationRevision: Sha256Revision;
  readonly input: JsonObject;
  readonly context?: InvocationContext;
  readonly dryRun?: boolean;
  readonly idempotencyKey?: string;
  readonly confirmation?: ConfirmationAcknowledgement;
}

export interface ConfirmationAcknowledgement extends Extensible {
  readonly operationId: ProtocolId;
  readonly operationRevision: Sha256Revision;
  readonly impact: OperationImpact;
}

export interface InvocationContext extends Extensible {
  readonly requestId: ProtocolId;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly actor?: { readonly id: ProtocolId; readonly displayName?: string };
  readonly target?: { readonly id: ProtocolId; readonly environment?: string };
}

export interface RunProgress extends Extensible {
  readonly current?: number;
  readonly total?: number;
  readonly phase?: string;
  readonly message?: string;
  readonly updatedAt: Rfc3339Timestamp;
}

export interface RunSummary extends Extensible {
  readonly title: string;
  readonly message?: string;
  readonly tone: "neutral" | "success" | "warning" | "error";
}

export type FollowUpAction =
  | { readonly kind: "invoke-operation"; readonly label: string; readonly operationId: ProtocolId; readonly input?: JsonObject }
  | { readonly kind: "open-link"; readonly label: string; readonly url: string }
  | { readonly kind: "browser-launch"; readonly label: string; readonly artifactId: ProtocolId };

export interface RunBase extends Extensible {
  readonly id: ProtocolId;
  readonly operationId: ProtocolId;
  readonly operationRevision: Sha256Revision;
  readonly sequence: number;
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
  readonly startedAt?: Rfc3339Timestamp;
  readonly progress?: RunProgress;
  readonly summary?: RunSummary;
  readonly output?: JsonValue;
  readonly artifacts: readonly Artifact[];
  readonly actions: readonly FollowUpAction[];
}

export type Run =
  | (RunBase & { readonly state: "queued" | "running"; readonly problem?: never; readonly completedAt?: never })
  | (RunBase & { readonly state: "succeeded"; readonly completedAt: Rfc3339Timestamp; readonly problem?: never })
  | (RunBase & {
      readonly state: "failed" | "partial" | "cancelled" | "timed_out" | "expired";
      readonly completedAt: Rfc3339Timestamp;
      readonly problem: Problem;
    });

export interface ArtifactBase extends Extensible {
  readonly id: ProtocolId;
  readonly title?: string;
}

export type Artifact =
  | (ArtifactBase & { readonly kind: "notice"; readonly level: "info" | "success" | "warning" | "error"; readonly message: string })
  | (ArtifactBase & { readonly kind: "metrics"; readonly metrics: readonly { readonly name: string; readonly value: number; readonly unit?: string }[] })
  | (ArtifactBase & { readonly kind: "key-value"; readonly entries: readonly { readonly key: string; readonly label: string; readonly value: JsonValue }[] })
  | (ArtifactBase & { readonly kind: "table"; readonly columns: readonly { readonly key: string; readonly label: string }[]; readonly rows: readonly JsonObject[] })
  | (ArtifactBase & { readonly kind: "json"; readonly value: JsonValue })
  | (ArtifactBase & { readonly kind: "markdown"; readonly markdown: string })
  | (ArtifactBase & { readonly kind: "diff"; readonly format: "unified"; readonly content: string })
  | (ArtifactBase & { readonly kind: "timeline"; readonly items: readonly { readonly timestamp: Rfc3339Timestamp; readonly title: string; readonly description?: string }[] })
  | (ArtifactBase & { readonly kind: "log"; readonly entries: readonly { readonly timestamp?: Rfc3339Timestamp; readonly level: "debug" | "info" | "warning" | "error"; readonly message: string }[] })
  | (ArtifactBase & { readonly kind: "download"; readonly url: string; readonly name: string; readonly mediaType: string; readonly sizeBytes?: number })
  | (ArtifactBase & { readonly kind: "link"; readonly label: string; readonly url: string })
  | (ArtifactBase & { readonly kind: "browser-launch"; readonly label: string })
  | (ArtifactBase & { readonly kind: `urn:${string}`; readonly data: JsonValue });

export interface RunEvent extends Extensible {
  readonly id: ProtocolId;
  readonly sequence: number;
  readonly occurredAt: Rfc3339Timestamp;
  readonly type: "run.updated";
  readonly run: Run;
}

export type DataSourceValue = string;

export interface DataSourceQuery extends Extensible {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly dependencies?: JsonPointerMap;
  readonly context?: InvocationContext;
}

export interface DataSourceItem extends Extensible {
  readonly value: DataSourceValue;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
  readonly disabled?: boolean;
  readonly metadata?: JsonObject;
}

export interface DataSourcePage extends Extensible {
  readonly items: readonly DataSourceItem[];
  readonly nextCursor?: string;
}

export interface DataSourceResolveRequest extends Extensible {
  readonly values: readonly DataSourceValue[];
  readonly dependencies?: JsonPointerMap;
  readonly context?: InvocationContext;
}

export interface DataSourceResolveResponse extends Extensible {
  readonly results: readonly { readonly value: DataSourceValue; readonly item: DataSourceItem | null }[];
}

export interface UploadResponse extends Extensible {
  readonly file: FileReference;
}

export interface SessionLaunchResponse extends Extensible {
  readonly url: string;
  readonly expiresAt: Rfc3339Timestamp;
  readonly singleUse: true;
}
