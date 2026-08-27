import { reactive } from "vue";
import {
  createCapabilities,
  defaultOperatorSettings,
  type ArmingDto,
  type CapabilitiesDto,
  type CatalogItemDto,
  type IpcErrorDto,
  type OperatorSettingsDto,
  type ParseClipboardResultDto,
  type QaActionTraceDto,
  type WorldStateDto,
} from "@poe2tc/core/operator";
import { resolvePreloadApi, withIpcError } from "./ipc/client.js";

const publicCaps = createCapabilities("public-companion");

export const operatorState = reactive({
  api: resolvePreloadApi(),
  capabilities: {
    mode: publicCaps.mode,
    canEmitNativeInput: publicCaps.canEmitNativeInput,
    qaBannerRequired: publicCaps.qaBannerRequired,
    modules: { ...publicCaps.modules },
  } as CapabilitiesDto,
  arming: {
    acknowledged: false,
    armed: false,
    emergencyStopLatched: false,
    dryRunDefault: true,
    allowlistedProcessNames: [],
    allowlistedWindowTitleIncludes: [],
  } as ArmingDto,
  world: undefined as WorldStateDto | undefined,
  traces: [] as QaActionTraceDto[],
  settings: defaultOperatorSettings() as OperatorSettingsDto,
  catalog: [] as CatalogItemDto[],
  priceCheck: undefined as ParseClipboardResultDto | undefined,
  ipcError: undefined as IpcErrorDto | undefined,
  loading: false,
});

export function dismissIpcError(): void {
  operatorState.ipcError = undefined;
}

function applyFailure(error: unknown): void {
  const result = withIpcError(operatorState.arming.armed, error);
  operatorState.ipcError = result.ipcError;
  operatorState.arming.armed = result.armed;
}

export async function refreshCapabilities(): Promise<void> {
  try {
    operatorState.capabilities = await operatorState.api.getCapabilities();
  } catch (error) {
    applyFailure(error);
  }
}

export async function refreshWorld(): Promise<void> {
  try {
    operatorState.world = await operatorState.api.getWorldState();
  } catch (error) {
    applyFailure(error);
  }
}

export async function refreshTraces(): Promise<void> {
  try {
    operatorState.traces = await operatorState.api.getTraces();
  } catch (error) {
    applyFailure(error);
  }
}

export async function refreshSettings(): Promise<void> {
  try {
    operatorState.settings = await operatorState.api.getSettings();
  } catch (error) {
    applyFailure(error);
  }
}

export async function refreshCatalog(): Promise<void> {
  try {
    operatorState.catalog = await operatorState.api.getCatalog();
  } catch (error) {
    applyFailure(error);
  }
}

export async function bootstrapOperator(): Promise<void> {
  operatorState.loading = true;
  await refreshCapabilities();
  await Promise.all([refreshWorld(), refreshTraces(), refreshSettings(), refreshCatalog()]);
  operatorState.loading = false;
}
