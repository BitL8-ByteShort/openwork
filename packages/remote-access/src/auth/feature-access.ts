import { BridgeError, record, type DeviceFeatureGrants } from '../contract/index.js';
import type { Device } from '../storage/store.js';

export type FeatureGrant = keyof DeviceFeatureGrants;
const keys: FeatureGrant[] = ['fileTransfer','workspaceAdministration','automationManagement'];
export function normalizeFeatureGrants(value: unknown): DeviceFeatureGrants {
  if (value !== undefined && (!record(value) || Object.keys(value).some(k => !keys.includes(k as FeatureGrant))
    || keys.some(k => value[k] !== undefined && typeof value[k] !== 'boolean'))) {
    throw new BridgeError('INVALID_REQUEST',400);
  }
  const v = record(value) ? value : {};
  return { fileTransfer:v.fileTransfer === true, workspaceAdministration:v.workspaceAdministration === true,
    automationManagement:v.automationManagement === true };
}
export function authorizeWorkspace(device: Device | undefined, workspaceId: string) {
  if (!device || !device.active || device.revoked) throw new BridgeError('UNAUTHORIZED',401);
  if (!device.allWorkspaces && !device.workspaceIds.includes(workspaceId)) throw new BridgeError('FORBIDDEN',403);
  return device;
}
export function authorizeFeature(device: Device | undefined, workspaceId: string, grant: FeatureGrant) {
  const authorized = authorizeWorkspace(device,workspaceId);
  if (normalizeFeatureGrants(authorized.features)[grant] !== true) throw new BridgeError('FORBIDDEN',403);
}

// Future transfers/settings operations use this lease before dispatch and after
// awaiting the native adapter. A captured authentication snapshot is insufficient.
export class FeatureOperations {
  private pending = new Map<string, Set<AbortController>>();
  private closed = false;
  constructor(private currentDevice: (id: string) => Device | undefined) {}
  begin(deviceId: string, workspaceId: string, grant: FeatureGrant) {
    if (this.closed) throw new BridgeError('BRIDGE_STOPPED');
    authorizeFeature(this.currentDevice(deviceId),workspaceId,grant);
    const controller = new AbortController();
    const set = this.pending.get(deviceId) ?? new Set<AbortController>();
    set.add(controller); this.pending.set(deviceId,set);
    return {
      signal: controller.signal,
      check: () => {
        if (this.closed || controller.signal.aborted) throw new BridgeError('FORBIDDEN',403);
        authorizeFeature(this.currentDevice(deviceId),workspaceId,grant);
      },
      dispose: () => {
        set.delete(controller);
        if (!set.size && this.pending.get(deviceId) === set) this.pending.delete(deviceId);
      },
    };
  }
  cancelDevice(deviceId: string) {
    for (const controller of this.pending.get(deviceId) ?? []) controller.abort();
    this.pending.delete(deviceId);
  }
  close() {
    this.closed = true;
    for (const deviceId of this.pending.keys()) this.cancelDevice(deviceId);
  }
}
