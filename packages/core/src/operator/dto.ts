import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import type { ArmingDto, CapabilitiesDto, WorldStateDto } from "./ipcTypes.js";
import type { QaActionTrace } from "../trace/types.js";
import type { WorldState } from "../world-state/types.js";

export function cloneDto<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function capabilitiesDto(capabilities: RuntimeCapabilities): CapabilitiesDto {
  return {
    mode: capabilities.mode,
    canEmitNativeInput: capabilities.canEmitNativeInput,
    qaBannerRequired: capabilities.qaBannerRequired,
    modules: { ...capabilities.modules },
  };
}

export function armingDto(arming: QaArmingState): ArmingDto {
  return cloneDto(arming);
}

export function worldStateDto(world: WorldState): WorldStateDto {
  return cloneDto(world);
}

export function tracesDto(traces: readonly QaActionTrace[]): QaActionTrace[] {
  return cloneDto([...traces]);
}
