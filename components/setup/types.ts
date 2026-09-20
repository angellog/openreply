import type { FieldGroup, FieldKind, GeneratorKind } from "@/lib/setup/fields";
import type { CheckStatus, SetupCheck } from "@/lib/setup/checks";
import type { MetaWizard } from "@/lib/setup/meta-wizard";
import type { TargetSummary, TargetTrigger } from "@/lib/setup/targets";
import type { WorkspaceSource } from "@/lib/setup/workspace";

export type { CheckStatus, SetupCheck, MetaWizard, TargetSummary, TargetTrigger };

export interface SetupField {
  name: string;
  label: string;
  group: FieldGroup;
  kind: FieldKind;
  required: boolean;
  help: string;
  placeholder: string | null;
  options: readonly string[] | null;
  generator: GeneratorKind | null;
  source: string | null;
  isSet: boolean;
  /** Masked when `secret` is true. */
  value: string;
  secret: boolean;
  error: string | null;
  warning: string | null;
}

export interface SetupAccount {
  id: string;
  username: string;
  instagramId: string;
  webhookSubscribed: boolean;
  tokenExpiresAt: string | null;
  connectedAt: string;
}

export interface SetupState {
  envFile: { path: string; exists: boolean; staleFields: string[] };
  groups: readonly { id: FieldGroup; title: string; description: string }[];
  fields: SetupField[];
  readiness: {
    checks: SetupCheck[];
    status: CheckStatus;
    ready: boolean;
    blockers: SetupCheck[];
  };
  metaWizard: MetaWizard;
  workspace: {
    workspaceId: string | null;
    source: WorkspaceSource;
    name: string | null;
    message: string | null;
  };
  session: { email: string | null; id: string | null } | null;
  accounts: SetupAccount[];
  targets: TargetSummary[];
  environment: string;
}

export interface InstagramPost {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}

export type TabId = "overview" | "environment" | "meta" | "targets" | "signin";
